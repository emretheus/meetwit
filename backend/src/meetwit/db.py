"""Database engine bootstrap.

V1 uses SQLite via SQLAlchemy 2 async. Each new connection loads the
sqlite-vec extension so vector virtual tables and `vec_distance_cosine`
are available everywhere.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from meetwit.sqlite_vec_loader import load_into_connection


def make_engine(db_path: Path) -> AsyncEngine:
    """Build an async SQLAlchemy engine for the given SQLite file path.

    Registers a ``connect`` event listener that loads ``sqlite-vec`` into
    every new raw connection — works in dev and in PyInstaller bundles.
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"sqlite+aiosqlite:///{db_path}"
    engine = create_async_engine(url, echo=False, future=True)

    # sync-only event hook; aiosqlite invokes it on the underlying connection.
    sync_engine = engine.sync_engine

    @event.listens_for(sync_engine, "connect")
    def _load_vec(dbapi_connection: object, _conn_record: object) -> None:
        load_into_connection(dbapi_connection)

    return engine


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
