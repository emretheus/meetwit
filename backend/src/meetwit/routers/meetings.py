"""Meeting CRUD + transcript persistence + live-assistant Q&A."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import structlog
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession as Session
from sse_starlette.sse import EventSourceResponse

from meetwit.llm import ChatMessage, OllamaProvider
from meetwit.llm.prompts import LIVE_ASSISTANT_SYSTEM, format_sources
from meetwit.models import Meeting, Transcript
from meetwit.retrieval import HybridRetriever

log = structlog.get_logger()
router = APIRouter(prefix="", tags=["meetings"])


# ─── Pydantic schemas ────────────────────────────────────────────────────


class MeetingCreate(BaseModel):
    title: str | None = None
    project: str | None = None


class MeetingPatch(BaseModel):
    title: str | None = None
    project: str | None = None
    status: str | None = None
    ended_at: datetime | None = None


class MeetingSummary(BaseModel):
    id: str
    title: str | None
    project: str | None
    started_at: str
    ended_at: str | None
    status: str
    transcript_count: int = 0


class TranscriptIn(BaseModel):
    text: str
    audio_start: float
    audio_end: float
    speaker: str | None = None


class TranscriptOut(BaseModel):
    id: int
    speaker: str | None
    text: str
    audio_start: float
    audio_end: float
    created_at: str


class TranscriptBatch(BaseModel):
    segments: list[TranscriptIn] = Field(default_factory=list)


class LiveAskRequest(BaseModel):
    meeting_id: str
    question: str
    model: str = "qwen2.5:7b-instruct"
    recent_seconds: int = 300
    top_k_docs: int = 5


# ─── Helpers ─────────────────────────────────────────────────────────────


def _engine(request: Request) -> object:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="db engine not initialized",
        )
    return engine


def _retriever(request: Request) -> HybridRetriever:
    r: HybridRetriever | None = getattr(request.app.state, "retriever", None)
    if r is None:
        r = HybridRetriever(request.app.state.engine, request.app.state.embedder)
        request.app.state.retriever = r
    return r


def _meeting_summary(m: Meeting, transcript_count: int) -> MeetingSummary:
    return MeetingSummary(
        id=m.id,
        title=m.title,
        project=m.project,
        started_at=m.started_at.isoformat(),
        ended_at=m.ended_at.isoformat() if m.ended_at else None,
        status=m.status,
        transcript_count=transcript_count,
    )


# ─── Meeting CRUD ────────────────────────────────────────────────────────


@router.post("/meetings", response_model=MeetingSummary)
async def create_meeting(body: MeetingCreate, request: Request) -> MeetingSummary:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        meeting = Meeting(
            title=body.title,
            project=body.project,
            started_at=datetime.now(UTC),
            status="recording",
        )
        session.add(meeting)
        await session.commit()
        await session.refresh(meeting)
        return _meeting_summary(meeting, transcript_count=0)


@router.get("/meetings", response_model=list[MeetingSummary])
async def list_meetings(request: Request) -> list[MeetingSummary]:
    engine = _engine(request)
    out: list[MeetingSummary] = []
    async with Session(engine) as session:  # type: ignore[arg-type]
        rows = await session.execute(select(Meeting).order_by(Meeting.started_at.desc()))
        meetings = rows.scalars().all()
        for m in meetings:
            count_rows = await session.execute(
                select(Transcript.id).where(Transcript.meeting_id == m.id)
            )
            count = len(count_rows.all())
            out.append(_meeting_summary(m, count))
    return out


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, request: Request) -> dict[str, object]:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        rows = await session.execute(
            select(Transcript)
            .where(Transcript.meeting_id == meeting_id)
            .order_by(Transcript.audio_start.asc())
        )
        transcripts = [
            TranscriptOut(
                id=t.id,
                speaker=t.speaker,
                text=t.text,
                audio_start=t.audio_start,
                audio_end=t.audio_end,
                created_at=t.created_at.isoformat(),
            ).model_dump()
            for t in rows.scalars().all()
        ]
        return {
            "meeting": _meeting_summary(m, len(transcripts)).model_dump(),
            "transcripts": transcripts,
        }


@router.patch("/meetings/{meeting_id}", response_model=MeetingSummary)
async def patch_meeting(meeting_id: str, body: MeetingPatch, request: Request) -> MeetingSummary:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        if body.title is not None:
            m.title = body.title
        if body.project is not None:
            m.project = body.project
        if body.status is not None:
            m.status = body.status
        if body.ended_at is not None:
            m.ended_at = body.ended_at
        await session.commit()
        count = await session.execute(
            select(Transcript.id).where(Transcript.meeting_id == meeting_id)
        )
        return _meeting_summary(m, len(count.all()))


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: str, request: Request) -> dict[str, object]:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        await session.delete(m)
        await session.commit()
    return {"deleted": meeting_id}


# ─── Transcripts ─────────────────────────────────────────────────────────


@router.post("/meetings/{meeting_id}/transcripts")
async def append_transcripts(
    meeting_id: str, body: TranscriptBatch, request: Request
) -> dict[str, object]:
    engine = _engine(request)
    async with Session(engine) as session:  # type: ignore[arg-type]
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        rows = [
            Transcript(
                meeting_id=meeting_id,
                speaker=seg.speaker,
                text=seg.text,
                audio_start=seg.audio_start,
                audio_end=seg.audio_end,
                created_at=datetime.now(UTC),
            )
            for seg in body.segments
        ]
        session.add_all(rows)
        await session.commit()
        return {"added": len(rows)}


# ─── Live Assistant ──────────────────────────────────────────────────────


@router.post("/live/ask")
async def live_ask(body: LiveAskRequest, request: Request) -> EventSourceResponse:
    engine = _engine(request)
    retriever = _retriever(request)
    provider: OllamaProvider = request.app.state.llm

    async with Session(engine) as session:  # type: ignore[arg-type]
        # Recent transcript window (the meeting's last `recent_seconds`).
        m = await session.get(Meeting, body.meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        rows = await session.execute(
            select(Transcript)
            .where(Transcript.meeting_id == body.meeting_id)
            .order_by(Transcript.audio_start.desc())
        )
        all_segs = list(rows.scalars().all())
    if all_segs:
        latest_t = max(s.audio_end for s in all_segs)
        cutoff = latest_t - body.recent_seconds
        window = sorted(
            (s for s in all_segs if s.audio_end >= cutoff),
            key=lambda s: s.audio_start,
        )
    else:
        window = []

    transcript_text = "\n".join(f"[{s.audio_start:6.1f}s] {s.text}" for s in window)

    chunks = await retriever.search(body.question, top_k=body.top_k_docs)
    sources_block = format_sources(chunks) if chunks else "(no relevant docs)"

    async def _stream() -> AsyncIterator[dict[str, str]]:
        yield {
            "event": "sources",
            "data": json.dumps(
                [
                    {
                        "label": str(i + 1),
                        "chunk_id": c.chunk_id,
                        "document_id": c.document_id,
                        "document_path": c.document_path,
                        "page_number": c.page_number,
                        "section_title": c.section_title,
                        "text": c.text,
                    }
                    for i, c in enumerate(chunks)
                ]
            ),
        }

        user_prompt = f"""LIVE MEETING TRANSCRIPT (last {body.recent_seconds}s):
{transcript_text or "(no transcript yet)"}

COMPANY DOCUMENTS:
{sources_block}

QUESTION: {body.question}

Answer briefly with [n] citations. If contradicting company knowledge, flag it.
"""
        messages = [
            ChatMessage(role="system", content=LIVE_ASSISTANT_SYSTEM),
            ChatMessage(role="user", content=user_prompt),
        ]
        try:
            async for token in provider.stream_chat(messages, model=body.model):
                yield {"event": "token", "data": token}
        except Exception as exc:
            yield {"event": "error", "data": str(exc)}
            log.warn("live.ask.stream_failed", err=str(exc))
            return
        yield {"event": "done", "data": ""}

    return EventSourceResponse(_stream())
