"""Knowledge-base indexer.

End-to-end: walk a folder → parse each file → chunk → embed → write to
``documents``, ``doc_chunks``, ``doc_chunks_vec``. Skips files whose hash
matches an already-indexed copy.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.ext.asyncio import AsyncSession as Session

from meetwit.indexing import Embedder, chunk_text, parse_file, supported_extensions
from meetwit.models import DocChunk, Document

log = structlog.get_logger()


@dataclass
class IndexProgress:
    total_files: int = 0
    processed_files: int = 0
    indexed_files: int = 0
    skipped_files: int = 0
    failed_files: int = 0
    current_file: str | None = None
    finished: bool = False
    error: str | None = None
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    finished_at: str | None = None


def file_hash(path: Path, chunk_size: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            block = f.read(chunk_size)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def discover_files(root: Path) -> list[Path]:
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"folder not found: {root}")
    exts = supported_extensions()
    return sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in exts)


async def index_folder(
    folder: Path,
    engine: AsyncEngine,
    embedder: Embedder,
    progress: IndexProgress,
) -> IndexProgress:
    """Walk ``folder``, parse + embed each supported file, update ``progress``."""
    try:
        files = discover_files(folder)
    except FileNotFoundError as err:
        progress.error = str(err)
        progress.finished = True
        progress.finished_at = datetime.now(UTC).isoformat()
        return progress

    progress.total_files = len(files)
    for fp in files:
        progress.current_file = str(fp)
        try:
            indexed = await _index_one(fp, engine, embedder)
            if indexed:
                progress.indexed_files += 1
            else:
                progress.skipped_files += 1
        except Exception as exc:
            log.warn("indexer.file_failed", path=str(fp), err=str(exc))
            progress.failed_files += 1
        progress.processed_files += 1

    progress.finished = True
    progress.finished_at = datetime.now(UTC).isoformat()
    progress.current_file = None
    return progress


async def _index_one(path: Path, engine: AsyncEngine, embedder: Embedder) -> bool:
    """Index a single file. Returns True if it was (re)indexed, False if skipped."""
    h = file_hash(path)
    suffix = path.suffix.lower().lstrip(".")

    async with Session(engine) as session:
        existing = await session.execute(select(Document).where(Document.path == str(path)))
        doc = existing.scalar_one_or_none()

        if doc and doc.file_hash == h and doc.status == "indexed":
            return False  # already indexed at this hash

        if doc is None:
            doc = Document(
                path=str(path),
                file_hash=h,
                file_type=suffix or "txt",
                indexed_at=datetime.now(UTC),
                chunk_count=0,
                status="pending",
            )
            session.add(doc)
            await session.flush()
        else:
            # Re-indexing: remove old chunks (cascade also clears vec table via FK)
            doc.file_hash = h
            doc.file_type = suffix or "txt"
            doc.status = "pending"
            doc.chunk_count = 0
            doc.error = None
            # Cascade ON DELETE removes from doc_chunks. doc_chunks_vec has no
            # FK, so wipe it explicitly first.
            chunk_ids = await session.execute(
                select(DocChunk.id).where(DocChunk.document_id == doc.id)
            )
            for (cid,) in chunk_ids:
                await session.execute(
                    text("DELETE FROM doc_chunks_vec WHERE chunk_id = :id"), {"id": cid}
                )
            await session.execute(
                text("DELETE FROM doc_chunks WHERE document_id = :id"), {"id": doc.id}
            )
            await session.flush()

        sections = parse_file(path)
        all_chunks: list[tuple[int, int | None, str | None, str]] = []
        for sec in sections:
            chunks = chunk_text(sec.text)
            for c in chunks:
                all_chunks.append((c.index, sec.page_number, sec.section_title, c.text))

        if not all_chunks:
            doc.status = "indexed"
            doc.chunk_count = 0
            await session.commit()
            return True

        chunk_texts = [c[3] for c in all_chunks]
        embeddings = embedder.encode(chunk_texts)

        new_chunk_rows: list[DocChunk] = []
        for idx, page, sect, txt in all_chunks:
            row = DocChunk(
                document_id=doc.id,
                chunk_index=idx,
                text=txt,
                page_number=page,
                section_title=sect,
                created_at=datetime.now(UTC),
            )
            new_chunk_rows.append(row)
        session.add_all(new_chunk_rows)
        await session.flush()

        # Now insert into the vector virtual table — match chunk.id to embedding row.
        for row, embedding in zip(new_chunk_rows, embeddings, strict=True):
            packed = struct.pack(f"<{len(embedding)}f", *embedding)
            await session.execute(
                text("INSERT INTO doc_chunks_vec(chunk_id, embedding) VALUES (:id, :v)"),
                {"id": row.id, "v": packed},
            )

        doc.chunk_count = len(new_chunk_rows)
        doc.status = "indexed"
        doc.indexed_at = datetime.now(UTC)
        await session.commit()
    return True
