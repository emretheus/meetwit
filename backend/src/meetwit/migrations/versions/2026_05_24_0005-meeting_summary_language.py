"""Add meetings.summary_language for localized summary generation (#413).

The summary's *output* language is decoupled from the spoken/transcription
language: a meeting held in English can be summarized in German, etc. This is
purely an LLM-prompt concern, so we only need to persist the user's chosen
ISO 639-1 code per meeting. Defaults to "en" for existing rows.

Revision ID: 0005_meeting_summary_language
Revises: 0004_calendar
Create Date: 2026-05-24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_meeting_summary_language"
down_revision: str | Sequence[str] | None = "0004_calendar"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.batch_alter_table("meetings") as batch:
        batch.add_column(
            sa.Column(
                "summary_language",
                sa.String(8),
                nullable=False,
                server_default="en",
            )
        )


def downgrade() -> None:
    with op.batch_alter_table("meetings") as batch:
        batch.drop_column("summary_language")
