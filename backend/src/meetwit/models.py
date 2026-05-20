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
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _now() -> datetime:
    return datetime.now(UTC)


def _uuid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    """Shared declarative base."""


# ─── Meetings + transcripts ─────────────────────────────────────────────


class Meeting(Base):
    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    title: Mapped[str | None] = mapped_column(String(255))
    project: Mapped[str | None] = mapped_column(String(255), index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    audio_path: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        String(32), default="recording"
    )  # recording|completed|failed

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


# Helper index for action item filtering (status + meeting).
Index("ix_action_items_status_meeting", ActionItem.status, ActionItem.meeting_id)
