"""Add transcript_chunks table + vec0 sibling for live transcript RAG.

Revision ID: 0002_transcript_chunks
Revises: 0001_v1_baseline
Create Date: 2026-05-20
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_transcript_chunks"
down_revision: str | Sequence[str] | None = "0001_v1_baseline"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "transcript_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column(
            "transcript_id",
            sa.Integer,
            sa.ForeignKey("transcripts.id", ondelete="SET NULL"),
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("audio_start", sa.Float(), nullable=False),
        sa.Column("audio_end", sa.Float(), nullable=False),
        sa.Column("speaker", sa.String(64)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Mirror sibling for the docs corpus: virtual table with same 384-dim BGE.
    op.execute(
        """
        CREATE VIRTUAL TABLE transcript_chunks_vec USING vec0(
            chunk_id INTEGER PRIMARY KEY,
            embedding float[384]
        )
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS transcript_chunks_vec")
    op.drop_table("transcript_chunks")
