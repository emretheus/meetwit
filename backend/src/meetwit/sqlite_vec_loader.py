"""Locate and load the ``sqlite-vec`` SQLite extension.

The Python wheel ships a `.dylib` (macOS) inside ``site-packages/sqlite_vec``.
At runtime, SQLite needs the *base* path (no suffix); ``load_extension``
auto-appends ``.dylib``/``.so``/``.dll`` per platform.

PyInstaller relocates the wheel content into ``sys._MEIPASS`` — this helper
finds it either way.

Captured in ADR-0001 risk register entry #3.
"""

from __future__ import annotations

import sys
from pathlib import Path

import sqlite_vec


def vec0_loadable_path() -> str:
    """Return the loader path that ``sqlite3.load_extension`` accepts.

    Search order:
      1. ``sqlite_vec.loadable_path()`` — supported API in dev.
      2. PyInstaller's extraction dir (``sys._MEIPASS``) for bundled builds.

    Returns the path **without** a platform suffix; SQLite appends one.
    """
    # 1. Library exposes its loader path explicitly.
    if hasattr(sqlite_vec, "loadable_path"):
        candidate = str(sqlite_vec.loadable_path())
        # Don't validate with .exists() — the returned base path has no
        # extension. We only sanity-check that the parent dir exists.
        if Path(candidate).parent.is_dir():
            return candidate

    # 2. PyInstaller --onedir relocates resources under sys._MEIPASS.
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        meipass_dir = Path(meipass) / "sqlite_vec"
        if meipass_dir.is_dir():
            return str(meipass_dir / "vec0")

    raise FileNotFoundError(
        "Could not locate the sqlite-vec extension. "
        "Verify `sqlite-vec` is installed (`uv pip show sqlite-vec`) "
        "or that the PyInstaller bundle includes sqlite_vec/."
    )


def load_into_connection(raw_connection: object) -> None:
    """Load the vec0 extension into a raw ``sqlite3.Connection``.

    Use via SQLAlchemy's ``connect`` event so it runs for every new connection.
    """
    raw_connection.enable_load_extension(True)  # type: ignore[attr-defined]
    raw_connection.load_extension(vec0_loadable_path())  # type: ignore[attr-defined]
    raw_connection.enable_load_extension(False)  # type: ignore[attr-defined]
