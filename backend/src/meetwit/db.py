"""Database engine bootstrap.

V1 uses SQLite via SQLAlchemy 2 async. Schema models arrive in Week 3.
This module is intentionally minimal in Week 1 — it only exposes a factory
so the rest of the codebase can import a stable name without coupling to
its (still-evolving) internals.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)


def make_engine(db_path: Path) -> AsyncEngine:
    """Build an async SQLAlchemy engine for the given SQLite file path."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"sqlite+aiosqlite:///{db_path}"
    return create_async_engine(url, echo=False, future=True)


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
