"""Swap embedding model to BGE-M3 (1024-dim) for multilingual RAG (#233/#427).

DESTRUCTIVE by necessity: the sqlite-vec virtual tables are fixed-dimension,
so moving from bge-small-en (384-dim) to BGE-M3 (1024-dim) means recreating
``doc_chunks_vec`` and ``transcript_chunks_vec`` at the new dimension. The old
384-dim vectors are semantically incompatible with BGE-M3 anyway, so they're
discarded.

Recovery path:
- Documents are reset to ``status='pending'`` and their chunk rows are cleared,
  so the next index run re-embeds them with BGE-M3 (the indexer re-reads the
  source files; nothing the user authored is lost).
- Past meetings' transcript_chunks are cleared (no auto re-embed trigger). The
  raw ``transcripts`` rows are untouched — the transcript text is preserved;
  only semantic search over old meetings needs a Retranscribe to rebuild.

Revision ID: 0008_bge_m3_embeddings
Revises: 0007_folders
Create Date: 2026-05-24
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0008_bge_m3_embeddings"
down_revision: str | Sequence[str] | None = "0007_folders"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OLD_DIM = 384
_NEW_DIM = 1024


def _recreate_vec(table: str, dim: int) -> None:
    op.execute(f"DROP TABLE IF EXISTS {table}")
    op.execute(
        f"""
        CREATE VIRTUAL TABLE {table} USING vec0(
            chunk_id INTEGER PRIMARY KEY,
            embedding float[{dim}]
        )
        """
    )


def upgrade() -> None:
    # 1. Recreate both vector tables at the new dimension.
    _recreate_vec("doc_chunks_vec", _NEW_DIM)
    _recreate_vec("transcript_chunks_vec", _NEW_DIM)

    # 2. Force documents to re-index (the indexer skips files whose status is
    #    already 'indexed' at the same hash). Clearing chunk rows ensures the
    #    re-index actually rebuilds them rather than leaving stale 384-dim text.
    op.execute("DELETE FROM doc_chunks")
    op.execute("UPDATE documents SET status = 'pending', chunk_count = 0")

    # 3. Drop past meetings' transcript chunks — no auto re-embed trigger, and
    #    stale 384-dim rows would mismatch the new 1024-dim table. Raw
    #    `transcripts` rows are intentionally left intact.
    op.execute("DELETE FROM transcript_chunks")


def downgrade() -> None:
    # Symmetric: recreate the vec tables at the old dimension and clear chunks.
    _recreate_vec("doc_chunks_vec", _OLD_DIM)
    _recreate_vec("transcript_chunks_vec", _OLD_DIM)
    op.execute("DELETE FROM doc_chunks")
    op.execute("UPDATE documents SET status = 'pending', chunk_count = 0")
    op.execute("DELETE FROM transcript_chunks")
