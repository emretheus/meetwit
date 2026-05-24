"""Add folders table + meetings.folder_id for nested organization (#424).

Self-referential folder tree. Meetings reference a folder with SET NULL on
delete so removing a folder never deletes the meetings inside it — they fall
back to the root. Child folders cascade-delete with their parent.

Revision ID: 0007_folders
Revises: 0006_notes
Create Date: 2026-05-24
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_folders"
down_revision: str | Sequence[str] | None = "0006_notes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "folders",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "parent_id",
            sa.String(36),
            sa.ForeignKey("folders.id", ondelete="CASCADE"),
            index=True,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    # Add the column without an inline FK constraint: SQLite batch-mode ALTER
    # can't add an unnamed FK, and FK enforcement is off on the app connection
    # anyway. The ORM-level relationship (Meeting.folder) supplies the FK for
    # query/relationship resolution; folder deletes clear meetings.folder_id at
    # the application layer (see Folder delete + the SET NULL intent).
    with op.batch_alter_table("meetings") as batch:
        batch.add_column(sa.Column("folder_id", sa.String(36), nullable=True))
    op.create_index("ix_meetings_folder_id", "meetings", ["folder_id"])


def downgrade() -> None:
    op.drop_index("ix_meetings_folder_id", table_name="meetings")
    with op.batch_alter_table("meetings") as batch:
        batch.drop_column("folder_id")
    op.drop_table("folders")
