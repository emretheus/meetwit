"""SQLAlchemy ORM models — relational tables only.

The vector virtual table ``doc_chunks_vec`` is created via raw SQL in the
Alembic migration (sqlite-vec virtual tables don't fit SQLAlchemy's
declarative pattern cleanly).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    """Shared declarative base."""


# ─── Folders (organization) ─────────────────────────────────────────────


class Folder(Base):
    """A nestable folder for organizing meetings (#424).

    Self-referential tree via ``parent_id``. Deleting a folder cascades to its
    child folders, but meetings inside use SET NULL (see Meeting.folder_id) so
    a deleted folder never deletes the meetings it held — they fall back to the
    root.
    """

    __tablename__ = "folders"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    parent_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("folders.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    parent: Mapped[Folder | None] = relationship(back_populates="children", remote_side=[id])
    children: Mapped[list[Folder]] = relationship(
        back_populates="parent", cascade="all, delete-orphan"
    )
    meetings: Mapped[list[Meeting]] = relationship(back_populates="folder")


# ─── Meetings + transcripts ─────────────────────────────────────────────


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str | None] = mapped_column(String(255))
    project: Mapped[str | None] = mapped_column(String(255), index=True)
    # Optional containing folder (#424). Null = lives at the root. SET NULL on
    # folder delete so meetings are never destroyed when a folder is removed.
    folder_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("folders.id", ondelete="SET NULL"), index=True
    )
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audio_path: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(32), default="recording"
    )  # recording|completed|failed
    # User-edited markdown summary (TipTap editor output). Distinct from the
    # AI-generated structured `summary` row — this is what the user typed/edited.
    summary_md: Mapped[str | None] = mapped_column(Text)
    # Set when the recording was started from a calendar event (ADR-0004). Not a
    # hard FK — the cached event row may be purged on calendar disconnect while
    # the meeting note (and its title pulled from the event) lives on.
    calendar_event_id: Mapped[str | None] = mapped_column(String(36), index=True)
    # ISO 639-1 code for the language the AI summary should be written in (#413).
    # Decoupled from the spoken language — defaults to English.
    summary_language: Mapped[str] = mapped_column(String(8), default="en", server_default="en")

    transcripts: Mapped[list[Transcript]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    decisions: Mapped[list[Decision]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    action_items: Mapped[list[ActionItem]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    conflicts: Mapped[list[Conflict]] = relationship(
        back_populates="meeting", cascade="all, delete-orphan"
    )
    summary: Mapped[Summary | None] = relationship(
        back_populates="meeting",
        cascade="all, delete-orphan",
        uselist=False,
    )
    notes: Mapped[list[Note]] = relationship(
        back_populates="meeting",
        cascade="all, delete-orphan",
        order_by="Note.created_at",
    )
    folder: Mapped[Folder | None] = relationship(back_populates="meetings")


class Transcript(Base):
    __tablename__ = "transcripts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    speaker: Mapped[str | None] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    audio_start: Mapped[float] = mapped_column(Float)
    audio_end: Mapped[float] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    meeting: Mapped[Meeting] = relationship(back_populates="transcripts")


class TranscriptChunk(Base):
    """Embedded slice of a meeting's transcript — the corpus for live RAG.

    One row per ingested transcript segment. We embed each segment as it
    arrives so "Ask the meeting" can do semantic search over what was just
    said, rather than relying on the document knowledge base or stuffing a
    raw 5-minute window into the LLM prompt.
    """

    __tablename__ = "transcript_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    transcript_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("transcripts.id", ondelete="SET NULL")
    )
    text: Mapped[str] = mapped_column(Text)
    audio_start: Mapped[float] = mapped_column(Float)
    audio_end: Mapped[float] = mapped_column(Float)
    speaker: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Note(Base):
    """A manual note the user jots during (or after) a meeting (#389).

    Distinct from the AI summary and the editable ``summary_md``: these are
    raw, time-stamped notes captured live in the meeting view. ``audio_offset``
    optionally pins the note to a moment on the recording timeline so it can be
    interleaved with the transcript on export.
    """

    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    text: Mapped[str] = mapped_column(Text)
    # Seconds from meeting start when the note was taken; null if added later.
    audio_offset: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now
    )

    meeting: Mapped[Meeting] = relationship(back_populates="notes")


# ─── Knowledge base ─────────────────────────────────────────────────────


class Document(Base):
    __tablename__ = "documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    path: Mapped[str] = mapped_column(Text, unique=True)
    file_hash: Mapped[str] = mapped_column(String(64))
    file_type: Mapped[str] = mapped_column(String(16))  # pdf|docx|md|txt
    indexed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # indexed|failed|pending
    error: Mapped[str | None] = mapped_column(Text)

    chunks: Mapped[list[DocChunk]] = relationship(
        back_populates="document", cascade="all, delete-orphan"
    )


class DocChunk(Base):
    __tablename__ = "doc_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    document_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    chunk_index: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    page_number: Mapped[int | None] = mapped_column(Integer)
    section_title: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    document: Mapped[Document] = relationship(back_populates="chunks")


# ─── Structured extractions ─────────────────────────────────────────────


class Summary(Base):
    __tablename__ = "summaries"

    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), primary_key=True
    )
    overview: Mapped[str | None] = mapped_column(Text)
    key_points: Mapped[list[str] | None] = mapped_column(JSON)
    company_context: Mapped[str | None] = mapped_column(Text)
    recommended_next_steps: Mapped[list[str] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    meeting: Mapped[Meeting] = relationship(back_populates="summary")


class Decision(Base):
    __tablename__ = "decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    text: Mapped[str] = mapped_column(Text)
    project: Mapped[str | None] = mapped_column(String(255), index=True)
    source_transcript_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("transcripts.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    meeting: Mapped[Meeting] = relationship(back_populates="decisions")


class ActionItem(Base):
    __tablename__ = "action_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    task: Mapped[str] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String(255))
    deadline: Mapped[str | None] = mapped_column(String(64))  # free-form date/text
    status: Mapped[str] = mapped_column(String(16), default="open")  # open|done
    source_transcript_id: Mapped[int | None] = mapped_column(
        Integer, ForeignKey("transcripts.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    meeting: Mapped[Meeting] = relationship(back_populates="action_items")


class Conflict(Base):
    __tablename__ = "conflicts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    meeting_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="CASCADE"), index=True
    )
    description: Mapped[str] = mapped_column(Text)
    conflicting_source_type: Mapped[str] = mapped_column(String(32))  # document|decision|action
    conflicting_source_id: Mapped[int | None] = mapped_column(Integer)
    suggested_action: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    meeting: Mapped[Meeting] = relationship(back_populates="conflicts")


# ─── Cross-meeting chat (Memory) ─────────────────────────────────────────


class MemoryChat(Base):
    __tablename__ = "memory_chats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str | None] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    messages: Mapped[list[MemoryMessage]] = relationship(
        back_populates="chat", cascade="all, delete-orphan"
    )


class MemoryMessage(Base):
    __tablename__ = "memory_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    chat_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("memory_chats.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))  # user|assistant
    content: Mapped[str] = mapped_column(Text)
    sources: Mapped[list[dict[str, object]] | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    chat: Mapped[MemoryChat] = relationship(back_populates="messages")


# ─── Settings ───────────────────────────────────────────────────────────


class Setting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str | None] = mapped_column(Text)


# ─── Calendar integration (ADR-0004) ─────────────────────────────────────


class CalendarAccount(Base):
    """A connected read-only calendar account.

    NOTE: no token columns. OAuth refresh tokens live in the macOS Keychain,
    owned by the Rust core and keyed by (provider, email). The sidecar only
    ever sees event *data*, never the user's Google/Microsoft credentials.
    """

    __tablename__ = "calendar_accounts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    provider: Mapped[str] = mapped_column(String(16))  # google|microsoft
    email: Mapped[str] = mapped_column(String(255), index=True)
    scopes: Mapped[str] = mapped_column(Text)  # space-joined granted scopes
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    events: Mapped[list[CalendarEvent]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )

    __table_args__ = (UniqueConstraint("provider", "email", name="uq_account_per_provider"),)


class CalendarEvent(Base):
    """Local cache of a fetched calendar event. Fetched read-only by Rust and
    upserted here; consumed by Home's "Today" list and (later) auto-detect."""

    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("calendar_accounts.id", ondelete="CASCADE"), index=True
    )
    external_id: Mapped[str] = mapped_column(String(255), index=True)  # provider event id
    title: Mapped[str | None] = mapped_column(String(512))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    attendees: Mapped[str | None] = mapped_column(Text)  # JSON: [{name,email,organizer}]
    description: Mapped[str | None] = mapped_column(Text)  # agenda
    conference_url: Mapped[str | None] = mapped_column(Text)
    conference_kind: Mapped[str | None] = mapped_column(String(16))  # zoom|meet|teams|null
    meeting_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="SET NULL"), nullable=True, index=True
    )

    account: Mapped[CalendarAccount] = relationship(back_populates="events")

    __table_args__ = (UniqueConstraint("account_id", "external_id", name="uq_event_per_account"),)


# Helper index for action item filtering (status + meeting).
Index("ix_action_items_status_meeting", ActionItem.status, ActionItem.meeting_id)
