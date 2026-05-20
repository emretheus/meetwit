"""Alembic env — uses the same engine factory as the app at runtime.

Synchronous mode (Alembic doesn't need async for our use case). Loads the
sqlite-vec extension on connect so migrations can create virtual tables.
"""

from __future__ import annotations

from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import create_engine, event, pool

from meetwit.config import get_settings
from meetwit.models import Base
from meetwit.sqlite_vec_loader import load_into_connection

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def _resolve_db_path() -> Path:
    """Allow override via ``-x db_path=/tmp/foo.sqlite`` for tests."""
    args = context.get_x_argument(as_dictionary=True)
    if "db_path" in args:
        return Path(args["db_path"])
    return get_settings().db_path


def run_migrations_online() -> None:
    db_path = _resolve_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"sqlite:///{db_path}"

    connectable = create_engine(url, poolclass=pool.NullPool, future=True)

    @event.listens_for(connectable, "connect")
    def _load_vec(dbapi_connection: object, _conn_record: object) -> None:
        load_into_connection(dbapi_connection)

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,  # SQLite-friendly DDL
        )
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
