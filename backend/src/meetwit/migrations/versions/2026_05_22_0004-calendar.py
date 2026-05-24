"""Add calendar_accounts + calendar_events tables and meetings.calendar_event_id.

Read-only calendar integration (ADR-0004). Tokens are NOT stored here — they
live in the macOS Keychain, owned by the Rust core. These tables hold only the
connected-account metadata and a local cache of fetched events.

Revision ID: 0004_calendar
Revises: 0003_meeting_summary_md
Create Date: 2026-05-22
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_calendar"
down_revision: str | Sequence[str] | None = "0003_meeting_summary_md"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "calendar_accounts",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("provider", sa.String(16), nullable=False),  # google|microsoft
        sa.Column("email", sa.String(255), nullable=False, index=True),
        sa.Column("scopes", sa.Text(), nullable=False),  # space-joined granted scopes
        sa.Column("connected_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("provider", "email", name="uq_account_per_provider"),
    )
    op.create_table(
        "calendar_events",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "account_id",
            sa.String(36),
            sa.ForeignKey("calendar_accounts.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("external_id", sa.String(255), nullable=False, index=True),
        sa.Column("title", sa.String(512)),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False, index=True),
        sa.Column("ends_at", sa.DateTime(timezone=True)),
        sa.Column("all_day", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("attendees", sa.Text()),  # JSON: [{name,email,organizer}]
        sa.Column("description", sa.Text()),  # agenda
        sa.Column("conference_url", sa.Text()),  # parsed Zoom/Meet/Teams link
        sa.Column("conference_kind", sa.String(16)),  # zoom|meet|teams|null
        sa.Column(
            "meeting_id",
            sa.String(36),
            sa.ForeignKey("meetings.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
        sa.UniqueConstraint("account_id", "external_id", name="uq_event_per_account"),
    )
    with op.batch_alter_table("meetings") as batch:
        batch.add_column(sa.Column("calendar_event_id", sa.String(36), nullable=True))
    op.create_index(
        "ix_meetings_calendar_event_id", "meetings", ["calendar_event_id"]
    )


def downgrade() -> None:
    op.drop_index("ix_meetings_calendar_event_id", table_name="meetings")
    with op.batch_alter_table("meetings") as batch:
        batch.drop_column("calendar_event_id")
    op.drop_table("calendar_events")
    op.drop_table("calendar_accounts")
