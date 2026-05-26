"""Manual meeting notes (#389).

Notes are short, time-stamped jottings the user makes during a live meeting —
separate from the AI summary and the editable ``summary_md``. They're scoped to
a meeting and ordered by creation time.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.models import Meeting, Note

router = APIRouter(prefix="", tags=["notes"])


class NoteCreate(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    audio_offset: float | None = Field(default=None, ge=0.0)


class NotePatch(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


class NoteOut(BaseModel):
    id: int
    meeting_id: str
    text: str
    audio_offset: float | None
    created_at: str
    updated_at: str


def _engine(request: Request) -> AsyncEngine:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="db engine not initialized",
        )
    return engine  # type: ignore[no-any-return]


def _serialize(n: Note) -> NoteOut:
    return NoteOut(
        id=n.id,
        meeting_id=n.meeting_id,
        text=n.text,
        audio_offset=n.audio_offset,
        created_at=n.created_at.isoformat(),
        updated_at=n.updated_at.isoformat(),
    )


@router.get("/meetings/{meeting_id}/notes", response_model=list[NoteOut])
async def list_notes(meeting_id: str, request: Request) -> list[NoteOut]:
    engine = _engine(request)
    async with Session(engine) as session:
        rows = await session.execute(
            select(Note).where(Note.meeting_id == meeting_id).order_by(Note.created_at.asc())
        )
        return [_serialize(n) for n in rows.scalars().all()]


@router.post("/meetings/{meeting_id}/notes", response_model=NoteOut)
async def create_note(meeting_id: str, body: NoteCreate, request: Request) -> NoteOut:
    engine = _engine(request)
    async with Session(engine) as session:
        meeting = await session.get(Meeting, meeting_id)
        if meeting is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="meeting not found")
        note = Note(
            meeting_id=meeting_id,
            text=body.text.strip(),
            audio_offset=body.audio_offset,
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
        session.add(note)
        await session.commit()
        await session.refresh(note)
        return _serialize(note)


@router.patch("/notes/{note_id}", response_model=NoteOut)
async def update_note(note_id: int, body: NotePatch, request: Request) -> NoteOut:
    engine = _engine(request)
    async with Session(engine) as session:
        note = await session.get(Note, note_id)
        if note is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="note not found")
        note.text = body.text.strip()
        await session.commit()
        await session.refresh(note)
        return _serialize(note)


@router.delete("/notes/{note_id}")
async def delete_note(note_id: int, request: Request) -> dict[str, int]:
    engine = _engine(request)
    async with Session(engine) as session:
        note = await session.get(Note, note_id)
        if note is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="note not found")
        await session.delete(note)
        await session.commit()
        return {"deleted": note_id}
