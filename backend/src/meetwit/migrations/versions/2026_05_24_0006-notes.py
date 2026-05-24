"""Add notes table for manual live notes during a meeting (#389).

Revision ID: 0006_notes
Revises: 0005_meeting_summary_language
Create Date: 2026-05-24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_notes"
down_revision: str | Sequence[str] | None = "0005_meeting_summary_language"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "notes",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            index=True,
            nullable=False,
        ),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("audio_offset", sa.Float()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("notes")
