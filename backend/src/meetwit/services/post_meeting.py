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
    MeetingTitle,
    structured_completion,
)
from meetwit.models import ActionItem, Decision, Meeting, Summary, Transcript
from meetwit.services.templates import language_instruction, resolve_summary_system

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

TITLE_SYSTEM = """Write a short, specific title for this meeting (3-7 words).
Output JSON: {"title": "..."}.
Rules:
- No trailing period.
- No quotes, no emoji, no markdown.
- Use Title Case (capitalize main words).
- Prefer concrete nouns from the transcript over generic words like
  "Discussion", "Meeting", "Call", "Sync" unless that's truly all the
  meeting was about.
- If nothing concrete was discussed, output "Untitled meeting".
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
    return "\n".join(f"[{r.audio_start:6.1f}s] {r.speaker or 'Speaker'}: {r.text}" for r in rows)


async def process_meeting(
    meeting_id: str,
    engine: AsyncEngine,
    settings: Settings,
    model: str,
    progress: PostMeetingProgress,
    *,
    llm_config: object | None = None,
    template_id: str | None = None,
    custom_prompt: str | None = None,
    language: str | None = None,
) -> PostMeetingProgress:
    try:
        async with Session(engine) as session:
            rows = await session.execute(
                select(Transcript)
                .where(Transcript.meeting_id == meeting_id)
                .order_by(Transcript.audio_start.asc())
            )
            transcripts = list(rows.scalars().all())
            # Fall back to the meeting's stored preference when the caller
            # didn't pass an explicit language (e.g. auto-summary on stop).
            if language is None:
                meeting_pref = await session.get(Meeting, meeting_id)
                language = meeting_pref.summary_language if meeting_pref else "en"

        if not transcripts:
            progress.error = "no transcripts to process"
            progress.finished = True
            progress.finished_at = datetime.now(UTC).isoformat()
            return progress

        transcript_text = _format_transcript(transcripts)
        base_url = settings.ollama_url
        # One trailing instruction reused across decisions/actions/title so the
        # entire summary comes out in the requested language (#413).
        lang_suffix = language_instruction(language)
        summary_system = resolve_summary_system(
            template_id=template_id, custom_prompt=custom_prompt, language=language
        )

        # 1. Summary
        progress.stage = "summary"
        summary_obj = await structured_completion(
            base_url=base_url,
            model=model,
            system=summary_system,
            user=f"MEETING TRANSCRIPT:\n{transcript_text}",
            schema_cls=MeetingSummary,
            llm_config=llm_config,
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
            system=DECISIONS_SYSTEM + lang_suffix,
            user=f"MEETING TRANSCRIPT:\n{transcript_text}",
            schema_cls=DecisionList,
            llm_config=llm_config,
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
            system=ACTIONS_SYSTEM + lang_suffix,
            user=f"MEETING TRANSCRIPT:\n{transcript_text}",
            schema_cls=ActionItemList,
            llm_config=llm_config,
        )
        async with Session(engine) as session:
            await session.execute(delete(ActionItem).where(ActionItem.meeting_id == meeting_id))
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

        # 4. Title — only if the user hasn't set one. We don't want the
        # AI overwriting "Q4 Planning Sync" with "Discussion Of Q4 Plans".
        progress.stage = "title"
        try:
            async with Session(engine) as session:
                meeting_obj = await session.get(Meeting, meeting_id)
                if meeting_obj is not None and not (meeting_obj.title or "").strip():
                    title_obj = await structured_completion(
                        base_url=base_url,
                        model=model,
                        system=TITLE_SYSTEM + lang_suffix,
                        user=f"MEETING TRANSCRIPT:\n{transcript_text}",
                        schema_cls=MeetingTitle,
                        llm_config=llm_config,
                    )
                    candidate = (title_obj.title or "").strip().strip('"').strip("'")
                    # Hard cap: keep it sane. DB column is 255 but a "title"
                    # longer than ~64 chars is almost certainly the model
                    # writing a sentence — truncate gracefully.
                    if candidate and len(candidate) <= 96:
                        meeting_obj.title = candidate
                        await session.commit()
        except Exception as exc:
            log.warning("post_meeting.title_failed", err=str(exc), meeting_id=meeting_id)

        progress.stage = "done"
    except Exception as exc:
        log.error("post_meeting.failed", err=str(exc), meeting_id=meeting_id)
        progress.error = str(exc)
        progress.stage = "failed"
    finally:
        progress.finished = True
        progress.finished_at = datetime.now(UTC).isoformat()
    return progress
