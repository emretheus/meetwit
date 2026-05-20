"""Hybrid retrieval test — index a small corpus, search, verify results."""

from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path

import pytest

from meetwit.db import make_engine
from meetwit.indexing import Embedder
from meetwit.retrieval import HybridRetriever
from meetwit.services.indexer import IndexProgress, index_folder


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


@pytest.fixture(scope="module")
def shared_db(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """One DB, one indexing run, shared across the retrieval tests."""
    tmp = tmp_path_factory.mktemp("retr")
    db_path = tmp / "test.sqlite"
    _alembic_upgrade(db_path)

    docs = tmp / "docs"
    docs.mkdir()
    (docs / "refund.md").write_text(
        """# Refund Policy

Customers may request a refund within 30 days of purchase.
Refunds require manager approval for amounts over 500 USD.
""",
        encoding="utf-8",
    )
    (docs / "discount.md").write_text(
        """# Discount Policy

Standard discount is 10 percent off list price.
The CFO must approve any discount above 15 percent.
""",
        encoding="utf-8",
    )
    (docs / "shipping.txt").write_text(
        "Shipping costs are flat 15 USD across the United States.",
        encoding="utf-8",
    )

    engine = make_engine(db_path)
    embedder = Embedder()
    progress = IndexProgress()
    asyncio.run(index_folder(docs, engine, embedder, progress))
    asyncio.run(engine.dispose())
    assert progress.indexed_files == 3
    return db_path


def test_hybrid_retriever_returns_relevant_chunk(shared_db: Path) -> None:
    engine = make_engine(shared_db)
    embedder = Embedder()
    retriever = HybridRetriever(engine, embedder)

    async def _go() -> None:
        results = await retriever.search("what is the maximum discount?", top_k=3)
        assert len(results) > 0
        # Top hit should be from the discount policy doc.
        assert "discount" in results[0].text.lower()
        # Confirm scores are descending.
        scores = [r.score for r in results]
        assert scores == sorted(scores, reverse=True)
        await engine.dispose()

    asyncio.run(_go())


def test_hybrid_retriever_empty_query(shared_db: Path) -> None:
    engine = make_engine(shared_db)
    embedder = Embedder()
    retriever = HybridRetriever(engine, embedder)

    async def _go() -> None:
        results = await retriever.search("", top_k=3)
        assert results == []
        await engine.dispose()

    asyncio.run(_go())
