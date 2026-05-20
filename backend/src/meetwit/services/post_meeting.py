"""Post-meeting pipeline: summary → decisions → action items → (conflicts in W12).

Runs after a meeting status is flipped to ``completed``. Idempotent — re-running
on the same meeting overwrites prior outputs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime

import structlog
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.config import Settings
from meetwit.llm.structured import (
    ActionItemList,
    DecisionList,
    MeetingSummary,
    structured_completion,
)
from meetwit.models import ActionItem, Decision, Summary, Transcript

log = structlog.get_logger()


SUMMARY_SYSTEM = """You are an assistant that writes concise meeting summaries.
Output JSON with keys: overview (≤200 words), key_points (list of short bullets),
company_context (single paragraph or null), recommended_next_steps (list of bullets).
No prose outside the JSON.
"""

DECISIONS_SYSTEM = """Extract every distinct decision made in this meeting.
A decision = a commitment to a course of action, a chosen option, a policy.
Output JSON: {"decisions": [{"text": "...", "project": "..." or null}]}.
Be conservative — only include explicit decisions. Empty list if none.
"""

ACTIONS_SYSTEM = """Extract every action item (task someone agreed to do).
Output JSON: {"action_items": [{"task": "...", "owner": "..." or null, "deadline": "..." or null}]}.
`owner` is whoever was named to do it (best guess; null if unclear).
`deadline` is a free-form date string if mentioned; null otherwise.
"""


@dataclass
class PostMeetingProgress:
    stage: str = "queued"  # queued|summary|decisions|actions|done|failed
    summary_done: bool = False
    decisions_done: bool = False
    actions_done: bool = False
    error: str | None = None
    finished: bool = False
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    finished_at: str | None = None


def _format_transcript(rows: list[Transcript]) -> str:
    return "\n".join(
        f"[{r.audio_start:6.1f}s] {r.speaker or 'Speaker'}: {r.text}" for r in rows
    )


async def process_meeting(
    meeting_id: str,
    engine: AsyncEngine,
    settings: Settings,
    model: str,
    progress: PostMeetingProgress,
) -> PostMeetingProgress:
    try:
        async with Session(engine) as session:
            rows = await session.execute(
                select(Transcript)
                .where(Transcript.meeting_id == meeting_id)
                .order_by(Transcript.audio_start.asc())
            )
            transcripts = list(rows.scalars().all())

        if not transcripts:
            progress.error = "no transcripts to process"
            progress.finished = True
            progress.finished_at = datetime.now(UTC).isoformat()
            return progress

        transcript_text = _format_transcript(transcripts)
        base_url = settings.ollama_url

        # 1. Summary
        progress.stage = "summary"
        summary_obj = await structured_completion(
            base_url=base_url,
            model=model,
            system=SUMMARY_SYSTEM,
            user=f"MEETING TRANSCRIPT:\n{transcript_text}",
            schema_cls=MeetingSummary,
        )
        async with Session(engine) as session:
            existing = await session.get(Summary, meeting_id)
            if existing is None:
                session.add(
                    Summary(
                        meeting_id=meeting_id,
                        overview=summary_obj.overview,
                        key_points=summary_obj.key_points,
                        company_context=summary_obj.company_context,
                        recommended_next_steps=summary_obj.recommended_next_steps,
                        created_at=datetime.now(UTC),
                    )
                )
            else:
                existing.overview = summary_obj.overview
                existing.key_points = summary_obj.key_points
                existing.company_context = summary_obj.company_context
                existing.recommended_next_steps = summary_obj.recommended_next_steps
            await session.commit()
        progress.summary_done = True

        # 2. Decisions
        progress.stage = "decisions"
        decisions = await structured_completion(
            base_url=base_url,
            model=model,
            system=DECISIONS_SYSTEM,
            user=f"MEETING TRANSCRIPT:\n{transcript_text}",
            schema_cls=DecisionList,
        )
        async with Session(engine) as session:
            # Idempotency: wipe prior decisions for this meeting.
            await session.execute(delete(Decision).where(Decision.meeting_id == meeting_id))
            for d in decisions.decisions:
                if d.text.strip():
                    session.add(
                        Decision(
                            meeting_id=meeting_id,
                            text=d.text,
                            project=d.project,
                            created_at=datetime.now(UTC),
                        )
                    )
            await session.commit()
        progress.decisions_done = True

        # 3. Action items
        progress.stage = "actions"
        actions = await structured_completion(
            base_url=base_url,
            model=model,
            system=ACTIONS_SYSTEM,
            user=f"MEETING TRANSCRIPT:\n{transcript_text}",
            schema_cls=ActionItemList,
        )
        async with Session(engine) as session:
            await session.execute(
                delete(ActionItem).where(ActionItem.meeting_id == meeting_id)
            )
            for a in actions.action_items:
                if a.task.strip():
                    session.add(
                        ActionItem(
                            meeting_id=meeting_id,
                            task=a.task,
                            owner=a.owner,
                            deadline=a.deadline,
                            status="open",
                            created_at=datetime.now(UTC),
                        )
                    )
            await session.commit()
        progress.actions_done = True

        progress.stage = "done"
    except Exception as exc:
        log.error("post_meeting.failed", err=str(exc), meeting_id=meeting_id)
        progress.error = str(exc)
        progress.stage = "failed"
    finally:
        progress.finished = True
        progress.finished_at = datetime.now(UTC).isoformat()
    return progress
