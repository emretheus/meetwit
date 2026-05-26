"""Conflict detection — flag transcript spans that contradict company knowledge.

For each "utterance batch" (~10-15 transcript segments), we:
  1. Concatenate the batch text.
  2. Retrieve top-K relevant doc chunks via HybridRetriever.
  3. Ask the LLM (JSON mode) which (if any) contradictions exist.
  4. Filter by confidence ≥ threshold (default 0.8).
  5. Insert into `conflicts` table.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

import structlog
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.indexing import Embedder
from meetwit.llm.prompts import format_sources
from meetwit.llm.structured import ConflictList, structured_completion
from meetwit.models import Conflict, Transcript
from meetwit.retrieval import HybridRetriever

log = structlog.get_logger()


CONFLICT_SYSTEM = """You are a meeting-AI looking for contradictions between
what was said in a live meeting and what the company has documented as policy
or prior decision.

Output JSON: {"conflicts":[{"description":"...","suggested_action":"...","confidence":0.0-1.0}]}

- A "conflict" is an explicit contradiction (e.g. policy says max discount 15%,
  meeting commits to 20%). Not vague tension or sentiment.
- "confidence" reflects how clearly the meeting text and the policy directly
  conflict, on a 0-1 scale. Be CONSERVATIVE: above 0.8 only when you'd bet
  on it. Use 0.5 for plausible-but-fuzzy. Use 0.0-0.3 to omit.
- "suggested_action" is a short next-step (e.g. "confirm CFO approval").
- Empty list if no genuine conflict.
"""

BATCH_SIZE = 12  # segments per batch
TOP_K_DOCS = 5
DEFAULT_CONFIDENCE_THRESHOLD = 0.8


@dataclass
class ConflictProgress:
    stage: str = "queued"  # queued|processing|done|failed
    batches_total: int = 0
    batches_done: int = 0
    conflicts_found: int = 0
    error: str | None = None
    finished: bool = False
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    finished_at: str | None = None


async def detect_conflicts(
    *,
    meeting_id: str,
    engine: AsyncEngine,
    embedder: Embedder,
    ollama_url: str,
    model: str,
    progress: ConflictProgress,
    confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
) -> ConflictProgress:
    progress.stage = "processing"
    try:
        async with Session(engine) as session:
            rows = await session.execute(
                select(Transcript)
                .where(Transcript.meeting_id == meeting_id)
                .order_by(Transcript.audio_start.asc())
            )
            transcripts = list(rows.scalars().all())
            # Idempotency: wipe previous conflicts for this meeting.
            await session.execute(delete(Conflict).where(Conflict.meeting_id == meeting_id))
            await session.commit()

        if not transcripts:
            progress.error = "no transcripts to process"
            return progress

        retriever = HybridRetriever(engine, embedder)
        batches = [transcripts[i : i + BATCH_SIZE] for i in range(0, len(transcripts), BATCH_SIZE)]
        progress.batches_total = len(batches)

        for batch in batches:
            batch_text = "\n".join(f"[{s.audio_start:6.1f}s] {s.text}" for s in batch)
            chunks = await retriever.search(batch_text, top_k=TOP_K_DOCS)
            sources = format_sources(chunks) if chunks else "(no relevant policy docs)"

            user_prompt = f"""MEETING SEGMENT:
{batch_text}

COMPANY KNOWLEDGE (potentially relevant):
{sources}

List any direct contradictions. Be conservative. Output JSON.
"""
            result = await structured_completion(
                base_url=ollama_url,
                model=model,
                system=CONFLICT_SYSTEM,
                user=user_prompt,
                schema_cls=ConflictList,
            )

            async with Session(engine) as session:
                for c in result.conflicts:
                    if c.confidence < confidence_threshold:
                        continue
                    session.add(
                        Conflict(
                            meeting_id=meeting_id,
                            description=c.description,
                            conflicting_source_type="document",
                            conflicting_source_id=chunks[0].document_id if chunks else None,
                            suggested_action=c.suggested_action,
                            confidence=c.confidence,
                            created_at=datetime.now(UTC),
                        )
                    )
                    progress.conflicts_found += 1
                await session.commit()
            progress.batches_done += 1

        progress.stage = "done"
    except Exception as exc:
        log.error("conflicts.failed", err=str(exc), meeting_id=meeting_id)
        progress.error = str(exc)
        progress.stage = "failed"
    finally:
        progress.finished = True
        progress.finished_at = datetime.now(UTC).isoformat()
    return progress
