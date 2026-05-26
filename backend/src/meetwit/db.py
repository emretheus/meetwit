"""Database engine bootstrap.

V1 uses SQLite via SQLAlchemy 2 async. The sqlite-vec extension is loaded
into every new aiosqlite connection via ``async_creator``. aiosqlite owns
its own worker thread; sqlite3 + load_extension both happen there, so
there's no cross-thread bridging to worry about.
"""

from __future__ import annotations

import sqlite3
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import aiosqlite
from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from meetwit.sqlite_vec_loader import load_into_connection, vec0_loadable_path


def _alembic_config(db_path: Path) -> AlembicConfig:
    """Build an Alembic config pointing at our migrations + the live DB.

    Two layouts: running from source (``backend/src/meetwit/...``) vs. frozen
    in a PyInstaller bundle, where the spec stages ``alembic.ini`` at the
    bundle root and migrations at ``meetwit/migrations`` (no ``src/``).
    """
    meipass = getattr(sys, "_MEIPASS", None)
    if getattr(sys, "frozen", False) and meipass:
        bundle_root = Path(meipass)
        ini_path = bundle_root / "alembic.ini"
        script_location = bundle_root / "meetwit" / "migrations"
    else:
        backend_root = Path(__file__).resolve().parents[2]  # backend/
        ini_path = backend_root / "alembic.ini"
        script_location = backend_root / "src" / "meetwit" / "migrations"

    cfg = AlembicConfig(str(ini_path))
    cfg.set_main_option("script_location", str(script_location))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")
    return cfg


def run_migrations(db_path: Path) -> None:
    """Run Alembic upgrade head against ``db_path``. Idempotent."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    cfg = _alembic_config(db_path)
    command.upgrade(cfg, "head")


def make_engine(db_path: Path) -> AsyncEngine:
    """Build an async SQLAlchemy engine with sqlite-vec preloaded per connection."""
    db_path.parent.mkdir(parents=True, exist_ok=True)

    async def _async_creator() -> aiosqlite.Connection:
        conn = await aiosqlite.connect(str(db_path))
        await conn.enable_load_extension(True)
        await conn.load_extension(vec0_loadable_path())
        await conn.enable_load_extension(False)
        return conn

    return create_async_engine(
        "sqlite+aiosqlite://",
        echo=False,
        future=True,
        async_creator=_async_creator,
    )


def make_sync_connection(db_path: Path) -> sqlite3.Connection:
    """Synchronous sqlite3 connection with sqlite-vec loaded — for tests / migrations."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    load_into_connection(conn)
    return conn


@asynccontextmanager
async def session_scope(engine: AsyncEngine) -> AsyncIterator[AsyncSession]:
    """Yield an ``AsyncSession`` bound to the given engine, committing on exit."""
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
