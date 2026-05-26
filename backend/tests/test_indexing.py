"""End-to-end indexing tests — parser → chunker → embedder → DB."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from meetwit.indexing import Embedder, chunk_text, parse_file
from meetwit.indexing.chunker import _split_into_sentences


def _alembic_upgrade(db_path: Path) -> None:
    backend_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-x",
            f"db_path={db_path}",
            "upgrade",
            "head",
        ],
        cwd=backend_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


@pytest.fixture()
def fresh_db(tmp_path: Path) -> Path:
    db = tmp_path / "test.sqlite"
    _alembic_upgrade(db)
    return db


def test_split_into_sentences_basic() -> None:
    text = "The first sentence. The second one is longer? Yes! Final words."
    sentences = _split_into_sentences(text)
    assert len(sentences) == 4
    assert sentences[0].endswith(".")
    assert sentences[2].endswith("!")


def test_chunker_respects_target_size() -> None:
    text = " ".join(f"word{i}." for i in range(2_000))  # 2000 short sentences
    chunks = chunk_text(text, chunk_tokens=200, overlap_tokens=20)
    assert len(chunks) > 1
    for c in chunks:
        # Each chunk should be ≤ target + a small buffer (one sentence).
        assert c.token_estimate <= 250
    # Index monotonically increasing.
    assert [c.index for c in chunks] == list(range(len(chunks)))


def test_chunker_empty_input() -> None:
    assert chunk_text("") == []
    assert chunk_text("   ") == []


def test_parse_markdown(tmp_path: Path) -> None:
    md = tmp_path / "doc.md"
    md.write_text(
        """# First Heading

Paragraph under first heading.

## Subheading

Another paragraph here. With multiple sentences.
""",
        encoding="utf-8",
    )
    sections = parse_file(md)
    assert len(sections) >= 2
    titles = {s.section_title for s in sections if s.section_title}
    assert "First Heading" in titles
    assert "Subheading" in titles


def test_parse_txt(tmp_path: Path) -> None:
    p = tmp_path / "doc.txt"
    p.write_text("Hello world.\nSecond line.", encoding="utf-8")
    sections = parse_file(p)
    assert len(sections) == 1
    assert "Hello world" in sections[0].text


def test_indexer_end_to_end(fresh_db: Path, tmp_path: Path, shared_embedder: Embedder) -> None:
    """Real indexing run on a small markdown file — verifies DB + vec table populated."""
    import asyncio

    from sqlalchemy import text

    from meetwit.db import make_engine
    from meetwit.services.indexer import IndexProgress, index_folder

    docs = tmp_path / "docs"
    docs.mkdir()
    (docs / "policy.md").write_text(
        """# Refund Policy

Customers may request a refund within 30 days of purchase.
Refunds require manager approval for amounts over 500 USD.
The policy applies to all SKUs in the catalog.
""",
        encoding="utf-8",
    )
    (docs / "notes.txt").write_text("Quarterly review notes for the team.", encoding="utf-8")

    engine = make_engine(fresh_db)

    progress = IndexProgress()

    asyncio.run(index_folder(docs, engine, shared_embedder, progress))

    assert progress.finished
    assert progress.error is None
    assert progress.total_files == 2
    assert progress.indexed_files == 2
    assert progress.failed_files == 0

    # Confirm rows landed.
    from sqlalchemy.ext.asyncio import AsyncSession as Session

    async def _check() -> None:
        async with Session(engine) as session:
            docs_count = (
                await session.execute(text("SELECT COUNT(*) FROM documents"))
            ).scalar_one()
            chunks_count = (
                await session.execute(text("SELECT COUNT(*) FROM doc_chunks"))
            ).scalar_one()
            vec_count = (
                await session.execute(text("SELECT COUNT(*) FROM doc_chunks_vec"))
            ).scalar_one()
            assert docs_count == 2
            assert chunks_count >= 1
            assert vec_count == chunks_count

    asyncio.run(_check())
    asyncio.run(engine.dispose())
