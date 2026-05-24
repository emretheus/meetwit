"""Add meetings.summary_md column for the editable TipTap summary.

Revision ID: 0003_meeting_summary_md
Revises: 0002_transcript_chunks
Create Date: 2026-05-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_meeting_summary_md"
down_revision: str | Sequence[str] | None = "0002_transcript_chunks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("meetings") as batch:
        batch.add_column(sa.Column("summary_md", sa.Text(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("meetings") as batch:
        batch.drop_column("summary_md")
