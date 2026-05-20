"""V1 baseline schema — all tables + sqlite-vec virtual table.

Revision ID: 0001_v1_baseline
Revises:
Create Date: 2026-05-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_v1_baseline"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ─── Meetings + transcripts ────────────────────────────────────────
    op.create_table(
        "meetings",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("title", sa.String(255)),
        sa.Column("project", sa.String(255), index=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("audio_path", sa.Text()),
        sa.Column("status", sa.String(32), nullable=False, server_default="recording"),
    )

    op.create_table(
        "transcripts",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("speaker", sa.String(64)),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("audio_start", sa.Float(), nullable=False),
        sa.Column("audio_end", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # ─── Knowledge base ────────────────────────────────────────────────
    op.create_table(
        "documents",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("path", sa.Text(), unique=True, nullable=False),
        sa.Column("file_hash", sa.String(64), nullable=False),
        sa.Column("file_type", sa.String(16), nullable=False),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("chunk_count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("status", sa.String(32), nullable=False, server_default="pending"),
        sa.Column("error", sa.Text()),
    )

    op.create_table(
        "doc_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "document_id",
            sa.Integer,
            sa.ForeignKey("documents.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("chunk_index", sa.Integer, nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("page_number", sa.Integer),
        sa.Column("section_title", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # sqlite-vec virtual table for 384-dim BGE-small embeddings.
    op.execute(
        """
        CREATE VIRTUAL TABLE doc_chunks_vec USING vec0(
            chunk_id INTEGER PRIMARY KEY,
            embedding float[384]
        )
        """
    )

    # ─── Structured extractions ────────────────────────────────────────
    op.create_table(
        "summaries",
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("overview", sa.Text()),
        sa.Column("key_points", sa.JSON()),
        sa.Column("company_context", sa.Text()),
        sa.Column("recommended_next_steps", sa.JSON()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "decisions",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("project", sa.String(255), index=True),
        sa.Column(
            "source_transcript_id",
            sa.Integer,
            sa.ForeignKey("transcripts.id", ondelete="SET NULL"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "action_items",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("task", sa.Text(), nullable=False),
        sa.Column("owner", sa.String(255)),
        sa.Column("deadline", sa.String(64)),
        sa.Column("status", sa.String(16), nullable=False, server_default="open"),
        sa.Column(
            "source_transcript_id",
            sa.Integer,
            sa.ForeignKey("transcripts.id", ondelete="SET NULL"),
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_action_items_status_meeting",
        "action_items",
        ["status", "meeting_id"],
    )

    op.create_table(
        "conflicts",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("conflicting_source_type", sa.String(32), nullable=False),
        sa.Column("conflicting_source_id", sa.Integer),
        sa.Column("suggested_action", sa.Text()),
        sa.Column("confidence", sa.Float()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # ─── Memory chat ───────────────────────────────────────────────────
    op.create_table(
        "memory_chats",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("title", sa.String(255)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        "memory_messages",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "chat_id",
            sa.Integer,
            sa.ForeignKey("memory_chats.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("sources", sa.JSON()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    # ─── Settings ──────────────────────────────────────────────────────
    op.create_table(
        "settings",
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", sa.Text()),
    )


def downgrade() -> None:
    # V1 baseline — no downgrade target. Re-create the DB instead.
    op.drop_table("settings")
    op.drop_table("memory_messages")
    op.drop_table("memory_chats")
    op.drop_table("conflicts")
    op.drop_index("ix_action_items_status_meeting", table_name="action_items")
    op.drop_table("action_items")
    op.drop_table("decisions")
    op.drop_table("summaries")
    op.execute("DROP TABLE IF EXISTS doc_chunks_vec")
    op.drop_table("doc_chunks")
    op.drop_table("documents")
    op.drop_table("transcripts")
    op.drop_table("meetings")
