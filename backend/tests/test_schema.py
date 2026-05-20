"""End-to-end schema test: fresh DB → migrate → insert vectors → KNN."""

from __future__ import annotations

import random
import struct
import subprocess
import sys
import time
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text

from meetwit.sqlite_vec_loader import load_into_connection


def _pack_f32(vec: list[float]) -> bytes:
    """sqlite-vec accepts vectors as raw little-endian f32 bytes."""
    return struct.pack(f"<{len(vec)}f", *vec)


def _random_vec(dim: int = 384, seed: int = 0) -> list[float]:
    rng = random.Random(seed)
    return [rng.uniform(-1.0, 1.0) for _ in range(dim)]


@pytest.fixture()
def fresh_db(tmp_path: Path) -> Path:
    """Run Alembic against a fresh SQLite file in tmp_path."""
    db_path = tmp_path / "test.sqlite"
    # Invoke alembic via subprocess so it uses our env.py + script_location.
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
    assert result.returncode == 0, (
        f"alembic upgrade failed:\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
    )
    return db_path


def test_baseline_migration_creates_all_tables(fresh_db: Path) -> None:
    expected = {
        "meetings",
        "transcripts",
        "documents",
        "doc_chunks",
        "doc_chunks_vec",
        "summaries",
        "decisions",
        "action_items",
        "conflicts",
        "memory_chats",
        "memory_messages",
        "settings",
    }
    engine = create_engine(f"sqlite:///{fresh_db}", future=True)

    @event.listens_for(engine, "connect")
    def _load_vec(dbapi_connection: object, _conn_record: object) -> None:
        load_into_connection(dbapi_connection)

    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
        ).fetchall()
    table_names = {r[0] for r in rows}
    missing = expected - table_names
    assert not missing, f"missing tables: {missing}"


def test_vector_insert_and_knn(fresh_db: Path) -> None:
    engine = create_engine(f"sqlite:///{fresh_db}", future=True)

    @event.listens_for(engine, "connect")
    def _load_vec(dbapi_connection: object, _conn_record: object) -> None:
        load_into_connection(dbapi_connection)

    with engine.begin() as conn:
        # Insert 100 random 384-dim vectors.
        for i in range(100):
            vec = _pack_f32(_random_vec(seed=i))
            conn.execute(
                text("INSERT INTO doc_chunks_vec(chunk_id, embedding) VALUES (:id, :v)"),
                {"id": i + 1, "v": vec},
            )

    with engine.connect() as conn:
        query_vec = _pack_f32(_random_vec(seed=42))
        t0 = time.perf_counter()
        rows = conn.execute(
            text(
                """
                SELECT chunk_id, distance
                FROM doc_chunks_vec
                WHERE embedding MATCH :v
                ORDER BY distance
                LIMIT 5
                """
            ),
            {"v": query_vec},
        ).fetchall()
        elapsed_ms = (time.perf_counter() - t0) * 1000

    assert len(rows) == 5, f"expected 5 KNN results, got {len(rows)}"
    # Distances should be non-decreasing.
    distances = [r[1] for r in rows]
    assert distances == sorted(distances)
    # Sanity-check perf — should be well under 50 ms on any modern Mac.
    assert elapsed_ms < 500, f"KNN took {elapsed_ms:.1f}ms — way slower than expected"
