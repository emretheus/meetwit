"""Meeting CRUD + transcript persistence + live-assistant Q&A."""

from __future__ import annotations

import json
import struct
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Literal

import structlog
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sse_starlette.sse import EventSourceResponse

from meetwit.indexing import Embedder
from meetwit.llm import ChatMessage, OllamaProvider
from meetwit.llm.prompts import (
    LIVE_ASSISTANT_SYSTEM,
    PROACTIVE_WATCHER_SYSTEM,
)
from meetwit.llm.providers import LlmConfig, LlmUnavailableError, Provider, msg, stream_chat
from meetwit.models import (
    ActionItem,
    CalendarEvent,
    Conflict,
    Decision,
    Folder,
    Meeting,
    Note,
    Transcript,
    TranscriptChunk,
)
from meetwit.retrieval import HybridRetriever


def Session(engine: AsyncEngine) -> AsyncSession:  # noqa: N802 — factory name mirrors SQLAlchemy convention
    """AsyncSession factory with `expire_on_commit=False`.

    The default `True` setting expires every attribute on every persistent
    instance after `commit()`. That's fine for sync sessions but lethal in
    async code: the next attribute read becomes implicit lazy IO, which
    cannot run from a non-greenlet context and crashes with
    `MissingGreenlet: greenlet_spawn has not been called`. We never need
    expiration semantics here (each handler operates on a freshly-fetched
    instance), so disable it globally for this router.
    """
    return AsyncSession(engine, expire_on_commit=False)


log = structlog.get_logger()
router = APIRouter(prefix="", tags=["meetings"])


# ─── Pydantic schemas ────────────────────────────────────────────────────


class MeetingCreate(BaseModel):
    title: str | None = None
    project: str | None = None


class MeetingPatch(BaseModel):
    title: str | None = Field(default=None, max_length=512)
    project: str | None = Field(default=None, max_length=255)
    status: Literal["recording", "completed", "failed"] | None = None
    ended_at: datetime | None = None
    summary_md: str | None = Field(default=None, max_length=200_000)
    audio_path: str | None = Field(default=None, max_length=4_096)
    summary_language: str | None = Field(default=None, max_length=8)
    # Move to a folder (#424). Omit to leave unchanged; pass null (with
    # set_folder=True) to move to root.
    folder_id: str | None = Field(default=None, max_length=36)
    set_folder: bool = False


class MeetingSummary(BaseModel):
    id: str
    title: str | None
    project: str | None
    started_at: str
    ended_at: str | None
    status: str
    transcript_count: int = 0
    summary_md: str | None = None
    audio_path: str | None = None
    calendar_event_id: str | None = None
    summary_language: str = "en"
    folder_id: str | None = None


class TranscriptIn(BaseModel):
    # A single VAD-bounded speech burst is short; cap defensively so a hostile
    # caller can't push a multi-megabyte "segment" that OOMs the embedder.
    text: str = Field(max_length=20_000)
    audio_start: float
    audio_end: float
    speaker: str | None = Field(default=None, max_length=128)


class TranscriptOut(BaseModel):
    id: int
    speaker: str | None
    text: str
    audio_start: float
    audio_end: float
    created_at: str


class TranscriptBatch(BaseModel):
    # Bound the batch so one request can't enqueue an unbounded embed workload.
    segments: list[TranscriptIn] = Field(default_factory=list, max_length=2_000)


class LiveAskTurn(BaseModel):
    """One turn of a multi-turn meeting chat. `assistant` turns may carry the
    sources that were attached to that earlier answer; we drop them from the
    re-fed history to save tokens (the model only needs the prose for
    follow-up continuity)."""

    role: str  # "user" | "assistant"
    content: str


class LiveAskRequest(BaseModel):
    meeting_id: str
    question: str = Field(max_length=8_000)
    model: str = Field(default="gemma3:1b", max_length=128)
    recent_seconds: int = Field(default=300, ge=0, le=86_400)
    top_k_docs: int = Field(default=5, ge=0, le=50)
    provider: Provider = "ollama"
    api_key: str | None = None
    base_url: str | None = None
    # Previous turns in this Ask session. The most recent user turn is the
    # current `question` field and is NOT duplicated here. Capped client-side
    # to the last ~6 turns (~3 exchanges) so the prompt stays bounded.
    history: list[LiveAskTurn] = Field(default_factory=list)


# ─── Helpers ─────────────────────────────────────────────────────────────


def _engine(request: Request) -> AsyncEngine:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="db engine not initialized",
        )
    return engine  # type: ignore[no-any-return]


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
        summary_md=m.summary_md,
        audio_path=m.audio_path,
        calendar_event_id=m.calendar_event_id,
        summary_language=m.summary_language or "en",
        folder_id=m.folder_id,
    )


# ─── Meeting CRUD ────────────────────────────────────────────────────────


@router.post("/meetings", response_model=MeetingSummary)
async def create_meeting(body: MeetingCreate, request: Request) -> MeetingSummary:
    engine = _engine(request)
    async with Session(engine) as session:
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
async def list_meetings(
    request: Request,
    folder_id: str | None = Query(default=None, max_length=36),
    root_only: bool = Query(default=False),
) -> list[MeetingSummary]:
    """List meetings, newest first.

    Folder filtering (#424): pass ``folder_id`` to list one folder's meetings,
    or ``root_only=true`` to list only meetings not in any folder. With neither,
    all meetings are returned (the default, unchanged behavior).
    """
    engine = _engine(request)
    out: list[MeetingSummary] = []
    async with Session(engine) as session:
        stmt = select(Meeting).order_by(Meeting.started_at.desc())
        if folder_id is not None:
            stmt = stmt.where(Meeting.folder_id == folder_id)
        elif root_only:
            stmt = stmt.where(Meeting.folder_id.is_(None))
        rows = await session.execute(stmt)
        meetings = rows.scalars().all()
        for m in meetings:
            count_rows = await session.execute(
                select(Transcript.id).where(Transcript.meeting_id == m.id)
            )
            count = len(count_rows.all())
            out.append(_meeting_summary(m, count))
    return out


class TranscriptHit(BaseModel):
    meeting_id: str
    meeting_title: str | None
    transcript_id: int
    audio_start: float
    snippet: str


@router.get("/meetings/search/transcripts", response_model=list[TranscriptHit])
async def search_transcripts(
    request: Request,
    q: str = Query(max_length=500),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[TranscriptHit]:
    """Case-insensitive substring search across transcript text.

    Cheap LIKE search (not the semantic /memory path) so the command palette
    can surface in-meeting line hits instantly. Returns a short snippet
    centered on the match.
    """
    engine = _engine(request)
    query = q.strip()
    if len(query) < 2:
        return []
    like = f"%{query}%"
    async with Session(engine) as session:
        rows = await session.execute(
            select(Transcript, Meeting)
            .join(Meeting, Meeting.id == Transcript.meeting_id)
            .where(Transcript.text.ilike(like))
            .order_by(Transcript.created_at.desc())
            .limit(limit)
        )
        hits: list[TranscriptHit] = []
        for t, m in rows.all():
            text = t.text
            idx = text.lower().find(query.lower())
            start = max(0, idx - 40)
            end = min(len(text), idx + len(query) + 60)
            snippet = (
                ("…" if start > 0 else "") + text[start:end] + ("…" if end < len(text) else "")
            )
            hits.append(
                TranscriptHit(
                    meeting_id=m.id,
                    meeting_title=m.title,
                    transcript_id=t.id,
                    audio_start=t.audio_start,
                    snippet=snippet,
                )
            )
        return hits


@router.get("/meetings/{meeting_id}")
async def get_meeting(meeting_id: str, request: Request) -> dict[str, object]:
    engine = _engine(request)
    async with Session(engine) as session:
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
        note_rows = await session.execute(
            select(Note).where(Note.meeting_id == meeting_id).order_by(Note.created_at.asc())
        )
        notes = [
            {
                "id": n.id,
                "meeting_id": n.meeting_id,
                "text": n.text,
                "audio_offset": n.audio_offset,
                "created_at": n.created_at.isoformat(),
                "updated_at": n.updated_at.isoformat(),
            }
            for n in note_rows.scalars().all()
        ]
        return {
            "meeting": _meeting_summary(m, len(transcripts)).model_dump(),
            "transcripts": transcripts,
            "notes": notes,
        }


@router.patch("/meetings/{meeting_id}", response_model=MeetingSummary)
async def patch_meeting(meeting_id: str, body: MeetingPatch, request: Request) -> MeetingSummary:
    engine = _engine(request)
    async with Session(engine) as session:
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
        if body.summary_md is not None:
            m.summary_md = body.summary_md
        if body.audio_path is not None:
            m.audio_path = body.audio_path
        if body.summary_language is not None:
            m.summary_language = body.summary_language.strip().lower() or "en"
        if body.set_folder:
            if body.folder_id is not None:
                target = await session.get(Folder, body.folder_id)
                if target is None:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST, detail="folder not found"
                    )
            m.folder_id = body.folder_id
        await session.commit()
        count = await session.execute(
            select(Transcript.id).where(Transcript.meeting_id == meeting_id)
        )
        return _meeting_summary(m, len(count.all()))


@router.delete("/meetings/{meeting_id}")
async def delete_meeting(meeting_id: str, request: Request) -> dict[str, object]:
    engine = _engine(request)
    async with Session(engine) as session:
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        # Unlink any cached calendar event so it becomes recordable again. The
        # FK is ON DELETE SET NULL, but SQLite only enforces FKs when
        # `PRAGMA foreign_keys=ON` is set per-connection (it isn't here), so we
        # clear the back-link explicitly rather than rely on the cascade.
        events = await session.execute(
            select(CalendarEvent).where(CalendarEvent.meeting_id == meeting_id)
        )
        for ev in events.scalars().all():
            ev.meeting_id = None
        await session.delete(m)
        await session.commit()
    return {"deleted": meeting_id}


# ─── Merge ───────────────────────────────────────────────────────────────


class MergeRequest(BaseModel):
    # Meetings to fold into the target, in the order they should be appended.
    source_ids: list[str] = Field(min_length=1, max_length=50)


class MergeResult(BaseModel):
    target_id: str
    merged_source_count: int
    transcripts_merged: int


@router.post("/meetings/{meeting_id}/merge", response_model=MergeResult)
async def merge_meetings(meeting_id: str, body: MergeRequest, request: Request) -> MergeResult:
    """Fold one or more source meetings into a target (#393).

    Source transcripts, chunks (incl. their vec rows — kept valid because chunk
    ids don't change, only ``meeting_id`` does), notes, decisions, action items
    and conflicts are reassigned to the target. Transcript/chunk/note timestamps
    are re-based onto a single continuous timeline so the merged transcript
    reads in order. Sources are then deleted. The target's cached AI summary is
    cleared so it regenerates over the combined transcript.

    Note: SQLite FKs aren't enforced on this connection, so every child table is
    reassigned explicitly rather than relying on cascades.
    """
    engine = _engine(request)

    # De-dupe while preserving order; reject self-merge.
    seen: set[str] = set()
    source_ids: list[str] = []
    for sid in body.source_ids:
        if sid == meeting_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST, detail="cannot merge a meeting into itself"
            )
        if sid not in seen:
            seen.add(sid)
            source_ids.append(sid)

    async with Session(engine) as session:
        target = await session.get(Meeting, meeting_id)
        if target is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="target meeting not found"
            )

        sources: list[Meeting] = []
        for sid in source_ids:
            src = await session.get(Meeting, sid)
            if src is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail=f"source meeting {sid} not found"
                )
            sources.append(src)

        async def _max_audio_end(mid: str) -> float:
            row = await session.execute(
                select(func.max(Transcript.audio_end)).where(Transcript.meeting_id == mid)
            )
            return float(row.scalar() or 0.0)

        # Running cursor: where the next source's timeline begins. Start just
        # past the target's own content.
        cursor = await _max_audio_end(meeting_id)
        transcripts_merged = 0

        for src in sources:
            offset = cursor
            src_span = await _max_audio_end(src.id)

            # Transcripts.
            t_rows = await session.execute(
                select(Transcript).where(Transcript.meeting_id == src.id)
            )
            for t in t_rows.scalars().all():
                t.meeting_id = meeting_id
                t.audio_start += offset
                t.audio_end += offset
                transcripts_merged += 1

            # Transcript chunks (vec rows keyed by chunk id stay valid).
            c_rows = await session.execute(
                select(TranscriptChunk).where(TranscriptChunk.meeting_id == src.id)
            )
            for c in c_rows.scalars().all():
                c.meeting_id = meeting_id
                c.audio_start += offset
                c.audio_end += offset

            # Notes pinned to the timeline.
            n_rows = await session.execute(select(Note).where(Note.meeting_id == src.id))
            for n in n_rows.scalars().all():
                n.meeting_id = meeting_id
                if n.audio_offset is not None:
                    n.audio_offset += offset

            # Decisions / action items / conflicts — no timeline, just reassign.
            # Bulk UPDATE keeps the ORM identity map out of it (no stale
            # cascade collections when we later delete the source).
            await session.execute(
                update(Decision).where(Decision.meeting_id == src.id).values(meeting_id=meeting_id)
            )
            await session.execute(
                update(ActionItem)
                .where(ActionItem.meeting_id == src.id)
                .values(meeting_id=meeting_id)
            )
            await session.execute(
                update(Conflict).where(Conflict.meeting_id == src.id).values(meeting_id=meeting_id)
            )

            # Extend the target's end time to cover this source.
            if src.ended_at is not None and (
                target.ended_at is None or src.ended_at > target.ended_at
            ):
                target.ended_at = src.ended_at

            cursor = offset + src_span

        # The target's cached summary is now stale — drop it so the next
        # post-meeting run regenerates over the full merged transcript.
        from meetwit.models import Summary

        await session.execute(delete(Summary).where(Summary.meeting_id == meeting_id))

        # Unlink calendar events of sources, then delete the source meetings.
        for src in sources:
            events = await session.execute(
                select(CalendarEvent).where(CalendarEvent.meeting_id == src.id)
            )
            for ev in events.scalars().all():
                ev.meeting_id = None
            await session.delete(src)

        await session.commit()

    # Invalidate retrieval BM25 so reassigned chunks are reflected.
    retriever: HybridRetriever | None = getattr(request.app.state, "retriever", None)
    if retriever is not None:
        retriever.invalidate()

    return MergeResult(
        target_id=meeting_id,
        merged_source_count=len(sources),
        transcripts_merged=transcripts_merged,
    )


# ─── Transcripts ─────────────────────────────────────────────────────────


async def _embed_transcript_segments(
    session: AsyncSession,
    embedder: Embedder,
    transcripts: list[Transcript],
) -> None:
    """Embed each new transcript row and store into transcript_chunks + vec0.

    Each transcript segment becomes exactly one chunk for V1. That's coarse
    (a long uninterrupted speech burst = one chunk), but Silero already
    gates segments to ~speech-burst granularity (250 ms - tens of seconds),
    which is roughly what you want a retrieval unit to be anyway. If we
    ever need sub-segment chunking we can do it here without changing the
    rest of the schema.

    Tolerates embed failures: a transcript without an embedded chunk still
    appears in the raw transcript view; it just won't be semantically
    searchable. Better to lose retrieval than to lose the transcript row.
    """
    embeddable = [t for t in transcripts if t.text and t.text.strip()]
    if not embeddable:
        return
    try:
        vectors = embedder.encode([t.text for t in embeddable])
    except Exception as exc:
        log.warn("transcript.embed_failed", err=str(exc))
        return

    chunks: list[TranscriptChunk] = []
    for t in embeddable:
        chunk = TranscriptChunk(
            meeting_id=t.meeting_id,
            transcript_id=t.id,
            text=t.text,
            audio_start=t.audio_start,
            audio_end=t.audio_end,
            speaker=t.speaker,
            created_at=datetime.now(UTC),
        )
        session.add(chunk)
        chunks.append(chunk)
    await session.flush()  # populate chunk.id values for the vec0 insert

    for c, vec in zip(chunks, vectors, strict=True):
        blob = struct.pack(f"<{len(vec)}f", *vec)
        # `INSERT OR REPLACE` rather than plain INSERT: vec0 is a virtual
        # table that doesn't fully participate in SQLite's normal txn
        # rollback semantics, so a prior failed batch could leave orphan
        # rows whose chunk_id collides with a freshly-flushed transcript
        # chunk. Replacing is idempotent and correct — for a given
        # chunk_id we always want the latest embedding.
        await session.execute(
            text(
                "INSERT OR REPLACE INTO transcript_chunks_vec(chunk_id, embedding) "
                "VALUES (:cid, :v)"
            ),
            {"cid": c.id, "v": blob},
        )


@router.post("/meetings/{meeting_id}/transcripts")
async def append_transcripts(
    meeting_id: str, body: TranscriptBatch, request: Request
) -> dict[str, object]:
    import traceback

    engine = _engine(request)
    embedder: Embedder = request.app.state.embedder
    try:
        async with Session(engine) as session:
            m = await session.get(Meeting, meeting_id)
            if m is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found"
                )
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
            # Flush so each Transcript row has its autoincrement id available
            # when we link TranscriptChunk.transcript_id below.
            await session.flush()
            try:
                await _embed_transcript_segments(session, embedder, rows)
            except Exception:
                # Embedding is best-effort. If it fails (sqlite-vec hiccup,
                # numpy edge case), still persist the raw transcripts so the
                # live UI keeps working. The chunk just won't be semantically
                # searchable until the next batch.
                log.warn("transcript.embed_pipeline_failed", tb=traceback.format_exc())
            await session.commit()
            return {"added": len(rows)}
    except HTTPException:
        raise
    except Exception:
        log.error("append_transcripts.crash", tb=traceback.format_exc())
        raise


@router.put("/meetings/{meeting_id}/transcripts")
async def replace_transcripts(
    meeting_id: str, body: TranscriptBatch, request: Request
) -> dict[str, object]:
    """Wipe a meeting's transcripts + chunks and insert a fresh batch.

    Used by retranscribe: the desktop app re-decodes the saved audio with a
    different Whisper model and replaces the whole transcript. We delete the
    old chunks (and their vec0 rows) so stale embeddings don't linger.
    """
    import traceback

    from sqlalchemy import delete

    engine = _engine(request)
    embedder: Embedder = request.app.state.embedder
    try:
        async with Session(engine) as session:
            m = await session.get(Meeting, meeting_id)
            if m is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found"
                )
            # Collect chunk ids first so we can purge their vec0 rows.
            chunk_ids = (
                (
                    await session.execute(
                        select(TranscriptChunk.id).where(TranscriptChunk.meeting_id == meeting_id)
                    )
                )
                .scalars()
                .all()
            )
            for cid in chunk_ids:
                await session.execute(
                    text("DELETE FROM transcript_chunks_vec WHERE chunk_id = :cid"),
                    {"cid": cid},
                )
            await session.execute(
                delete(TranscriptChunk).where(TranscriptChunk.meeting_id == meeting_id)
            )
            await session.execute(delete(Transcript).where(Transcript.meeting_id == meeting_id))

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
            await session.flush()
            try:
                await _embed_transcript_segments(session, embedder, rows)
            except Exception:
                log.warn("transcript.replace_embed_failed", tb=traceback.format_exc())
            await session.commit()
            return {"replaced": len(rows)}
    except HTTPException:
        raise
    except Exception:
        log.error("replace_transcripts.crash", tb=traceback.format_exc())
        raise


# ─── Live Assistant ──────────────────────────────────────────────────────


# Minimum cosine *distance* below which a document hit is considered
# genuinely relevant. sqlite-vec returns L2 distance on unit-normalised
# BGE-small vectors (range ~0-2); empirically <0.85 means "actually about
# the question", >0.85 means "best match but unrelated". Tuned for the
# default gemma3:1b + small.en transcript stack.
DOC_RELEVANCE_THRESHOLD = 0.85


@router.post("/live/ask")
async def live_ask(body: LiveAskRequest, request: Request) -> EventSourceResponse:
    engine = _engine(request)
    settings = request.app.state.settings
    base_cfg = LlmConfig(
        provider=body.provider,  # type: ignore[arg-type]
        model=body.model,
        api_key=body.api_key,
        base_url=body.base_url,
    )

    # Sanity-check the meeting exists. Avoids returning empty results for a
    # garbage id without any cue to the caller. While we have the row, pull the
    # linked calendar event's agenda (ADR-0004) so the Copilot can answer
    # "what from the agenda haven't we covered yet?".
    agenda: str | None = None
    async with Session(engine) as session:
        m = await session.get(Meeting, body.meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        if m.calendar_event_id:
            ev = await session.get(CalendarEvent, m.calendar_event_id)
            if ev is not None and ev.description and ev.description.strip():
                agenda = ev.description.strip()[:4_000]

    # The live Copilot answers from THIS meeting's transcript only — not
    # indexed documents. (Cross-document Q&A lives on the /memory page.)
    #
    # We feed the FULL meeting transcript (chronological), not semantic chunks,
    # so the model reasons over everything that was said. Live meetings are
    # small (a 1-hour meeting is ~10-15k tokens), so this fits comfortably; we
    # cap to the most recent ~MAX_TRANSCRIPT_CHARS to stay safe on long ones.
    max_transcript_chars = 48_000  # ~12k tokens of recent transcript
    # Pull only the most recent N segments from SQL (newest-first + LIMIT) rather
    # than materializing the whole meeting into memory — so a meeting stuffed
    # with thousands of segments can't OOM the request. The MAX_SEGMENTS ceiling
    # is generous (a 1h meeting is ~hundreds of segments) and the char budget
    # below trims further.
    max_segments = 4_000
    async with Session(engine) as session:
        rows = await session.execute(
            select(Transcript)
            .where(Transcript.meeting_id == body.meeting_id)
            .order_by(Transcript.audio_start.desc())
            .limit(max_segments)
        )
        recent_desc = list(rows.scalars().all())

    # Walk newest→oldest accumulating up to the char budget, then restore
    # chronological order for the prompt.
    kept: list[Transcript] = []
    running_chars = 0
    for seg in recent_desc:
        running_chars += len(seg.text or "")
        kept.append(seg)
        if running_chars >= max_transcript_chars:
            break
    kept.reverse()

    # Build the transcript block for the prompt + the sources payload.
    #
    # Prompt format note: we number lines as a plain "(n) text" — NOT
    # "[T n] (mm:ss) Speaker: text". Small local models (e.g. gemma3:1b) tend to
    # *continue* a richly-formatted transcript block verbatim instead of
    # answering, especially once the block is large. The plain numbered form is
    # far less mimicable, which (with the one-shot example in the system prompt)
    # stops the echo. The sources panel still uses the structured payload below,
    # so citations/click-to-scroll are unaffected by this format change.
    transcript_lines: list[str] = []
    sources_payload: list[dict[str, object]] = []
    for i, seg in enumerate(kept, start=1):
        transcript_lines.append(f"({i}) {seg.text}")
        sources_payload.append(
            {
                "kind": "transcript",
                "label": f"T{i}",
                "chunk_id": seg.id,
                "meeting_id": body.meeting_id,
                "transcript_id": seg.id,
                "audio_start": seg.audio_start,
                "audio_end": seg.audio_end,
                "speaker": seg.speaker,
                "text": seg.text,
            }
        )

    if transcript_lines:
        sources_block = "Transcript:\n" + "\n".join(transcript_lines)
    else:
        sources_block = "Transcript:\n(empty so far)"

    # Prepend the calendar agenda (if any) so the model can reason about what
    # was *planned* vs. what's been discussed.
    if agenda:
        sources_block = f"Agenda (from the calendar invite):\n{agenda}\n\n{sources_block}"

    async def _stream() -> AsyncIterator[dict[str, str]]:
        # Emit the transcript segments as [T n] sources (built above from the
        # full chronological transcript). Citations + the sources panel work
        # against these.
        yield {"event": "sources", "data": json.dumps(sources_payload)}

        # Build the chat: system → prior turns (history) → fresh user turn with sources.
        # Sources go with the *current* user turn only — old turns kept their
        # citation labels in their text, but we don't re-attach old corpora
        # (the snippets would be stale and waste tokens).
        history_messages = []
        for turn in body.history[-12:]:  # cap at 12 turns (~6 exchanges)
            role = turn.role.lower().strip()
            if role not in ("user", "assistant"):
                continue
            text_ = turn.content.strip()
            if not text_:
                continue
            history_messages.append(msg(role, text_))

        user_prompt = f"""{sources_block}

Question: {body.question}
Answer:"""
        messages = [
            msg("system", LIVE_ASSISTANT_SYSTEM),
            *history_messages,
            msg("user", user_prompt),
        ]
        # Resolve the model now — falls back to an installed one, or emits a
        # clear error if Ollama is down / empty (instead of hanging forever).
        try:
            llm_cfg = await base_cfg.resolve(ollama_url=settings.ollama_url)
        except LlmUnavailableError as exc:
            yield {"event": "error", "data": str(exc)}
            return
        try:
            async for token in stream_chat(llm_cfg, messages):
                yield {"event": "token", "data": token}
        except Exception as exc:
            yield {"event": "error", "data": str(exc)}
            log.warn("live.ask.stream_failed", err=str(exc))
            return
        yield {"event": "done", "data": ""}

    return EventSourceResponse(_stream())


# ─── Proactive watcher ───────────────────────────────────────────────────


class InsightScanRequest(BaseModel):
    meeting_id: str
    # Only consider transcript whose `audio_end` is greater than this. The
    # client tracks the highest end-time it has already scanned to avoid
    # redundant work and duplicate insights.
    since_audio_seconds: float = Field(default=0.0, ge=0.0)
    model: str = Field(default="gemma3:1b", max_length=128)


class Insight(BaseModel):
    kind: str  # contradiction|risk|commitment|decision
    severity: str  # low|medium|high
    headline: str
    detail: str
    evidence_quote: str
    evidence_timestamp_seconds: float
    conflicts_with: str | None = None


class InsightScanResponse(BaseModel):
    insights: list[Insight]
    scanned_through_seconds: float


@router.post("/meetings/{meeting_id}/insights/scan", response_model=InsightScanResponse)
async def scan_insights(
    meeting_id: str, body: InsightScanRequest, request: Request
) -> InsightScanResponse:
    """Run one proactive-watcher pass over the new transcript since `since_audio_seconds`.

    Cheap (one short LLM call, ~1-2s on gemma3:1b) and idempotent —
    the client calls this periodically while a meeting is live.
    """
    engine = _engine(request)
    retriever = _retriever(request)
    provider: OllamaProvider = request.app.state.llm

    async with Session(engine) as session:
        m = await session.get(Meeting, meeting_id)
        if m is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        rows = await session.execute(
            select(Transcript)
            .where(
                Transcript.meeting_id == meeting_id,
                Transcript.audio_end > body.since_audio_seconds,
            )
            .order_by(Transcript.audio_start.asc())
        )
        new_segments = list(rows.scalars().all())

    # If there's nothing new (or so little that scanning would be noise), bail.
    if len(new_segments) < 2:
        return InsightScanResponse(insights=[], scanned_through_seconds=body.since_audio_seconds)

    transcript_block = "\n".join(
        f"[{s.audio_start:.1f}s] {s.text}" for s in new_segments if s.text.strip()
    )

    # Pull a couple of policy/doc snippets that look relevant to the new
    # transcript window. We use the joined text as the search query — coarse
    # but cheap, and sufficient for catching "X says Z but policy says Y".
    doc_query = " ".join(s.text for s in new_segments[-5:])
    doc_hits = await retriever.search(doc_query, top_k=4)
    doc_hits = [c for c in doc_hits if (c.vector_rank is not None and c.vector_rank <= 3)]

    doc_block = ""
    if doc_hits:
        lines = ["RELEVANT POLICY / KNOWLEDGE BASE:"]
        for i, c in enumerate(doc_hits, start=1):
            label = c.document_path.split("/")[-1]
            loc = c.section_title or (f"p.{c.page_number}" if c.page_number is not None else "")
            header = f"[D{i}] {label}" + (f" ({loc})" if loc else "")
            lines.append(f"{header}\n{c.text.strip()}")
        doc_block = "\n".join(lines)

    user_prompt = f"""NEW TRANSCRIPT (since {body.since_audio_seconds:.1f}s):
{transcript_block}

{doc_block}

Scan the new transcript and output insights JSON per the system prompt. Default is {{"insights": []}}."""
    messages = [
        ChatMessage(role="system", content=PROACTIVE_WATCHER_SYSTEM),
        ChatMessage(role="user", content=user_prompt),
    ]

    try:
        raw = await provider.chat(messages, model=body.model, temperature=0.1)
    except Exception as exc:
        log.warn("insights.scan_llm_failed", err=str(exc))
        return InsightScanResponse(insights=[], scanned_through_seconds=body.since_audio_seconds)

    insights = _parse_insights(raw, new_segments)

    new_high_water = max(s.audio_end for s in new_segments)
    return InsightScanResponse(insights=insights, scanned_through_seconds=new_high_water)


def _parse_insights(raw: str, segments: list[Transcript]) -> list[Insight]:
    """Best-effort JSON extraction. Tolerates code-fenced output."""
    cleaned = raw.strip()
    # Some local models still wrap JSON in ```json ... ``` fences even when
    # told not to. Strip if present.
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].lstrip()
        cleaned = cleaned.rsplit("```", 1)[0].strip()
    try:
        parsed = json.loads(cleaned)
    except (ValueError, TypeError) as exc:
        log.warn("insights.parse_failed", err=str(exc), raw=cleaned[:200])
        return []

    items = parsed.get("insights") if isinstance(parsed, dict) else parsed
    if not isinstance(items, list):
        return []

    valid_kinds = {"contradiction", "risk", "commitment", "decision"}
    valid_sev = {"low", "medium", "high"}
    transcript_text = "\n".join(s.text for s in segments)

    out: list[Insight] = []
    for item in items[:2]:  # hard cap matches the system prompt
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind", "")).lower()
        severity = str(item.get("severity", "low")).lower()
        headline = str(item.get("headline", "")).strip()
        detail = str(item.get("detail", "")).strip()
        evidence_quote = str(item.get("evidence_quote", "")).strip()
        ts_raw = item.get("evidence_timestamp_seconds", 0.0)
        try:
            ts = float(ts_raw)
        except (TypeError, ValueError):
            ts = 0.0
        if kind not in valid_kinds or not headline or not evidence_quote:
            continue
        # Sanity-check the quote actually appears in the new transcript window.
        # Filters out fabricated quotes the model occasionally invents.
        if evidence_quote not in transcript_text:
            log.info("insights.quote_not_found", quote=evidence_quote[:100])
            continue
        out.append(
            Insight(
                kind=kind,
                severity=severity if severity in valid_sev else "low",
                headline=headline,
                detail=detail,
                evidence_quote=evidence_quote,
                evidence_timestamp_seconds=ts,
                conflicts_with=(
                    str(item["conflicts_with"]).strip() if item.get("conflicts_with") else None
                ),
            )
        )
    return out
