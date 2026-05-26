# PyInstaller spec for the Meetwit sidecar binary.
#
# Build with:    cd backend && uv run pyinstaller meetwit-sidecar.spec --noconfirm
# Output:        backend/dist/meetwit-sidecar/   (--onedir layout)
#
# The output directory is copied wholesale into the Tauri .app bundle at
# Contents/Resources/python-backend/ (wired in build-release.sh, W15).

# ruff: noqa
# mypy: ignore-errors

import os
import sys
from pathlib import Path

block_cipher = None

backend_root = Path(SPECPATH).resolve()  # noqa: F821  (SPECPATH is injected by PyInstaller)
src_root = backend_root / "src"

# sqlite-vec bundled dylib needs explicit inclusion — PyInstaller misses it
# because the loader path is computed at runtime.
try:
    import sqlite_vec
    sqlite_vec_pkg_dir = Path(sqlite_vec.__file__).parent
    sqlite_vec_datas = [
        (str(sqlite_vec_pkg_dir / fn), "sqlite_vec")
        for fn in os.listdir(sqlite_vec_pkg_dir)
        if fn.startswith(("vec0", "libvec0")) and fn.endswith((".dylib", ".so", ".dll"))
    ]
except ImportError:
    sqlite_vec_datas = []

# Alembic needs its env.py + migrations folder.
alembic_datas = [
    (str(src_root / "meetwit" / "migrations"), "meetwit/migrations"),
    (str(backend_root / "alembic.ini"), "."),
]

# sentence-transformers + transformers cache (BGE-small) is downloaded on first
# run by default; that's fine for V1 since the user already has a network for
# Ollama. If we ever want to bundle it, that's where it'd go.

a = Analysis(
    [str(src_root / "meetwit" / "__main__.py")],
    pathex=[str(src_root)],
    binaries=[],
    datas=sqlite_vec_datas + alembic_datas,
    hiddenimports=[
        "sqlite_vec",
        "aiosqlite",
        "uvicorn.logging",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Dev-only tooling that leaks in from the dev venv. It must NOT ship: its
    # native .so files (e.g. mypy's compiled modules) are unsigned and fail
    # notarization, and it's dead weight at runtime.
    excludes=[
        "mypy",
        "mypyc",
        "pytest",
        "_pytest",
        "ruff",
        "pyinstaller",
        "PyInstaller",
        "pip",
        "setuptools",
        "wheel",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="meetwit-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,        # write to stderr — Tauri pipes stderr into its log
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,    # signed downstream in build-release.sh (W15)
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="meetwit-sidecar",
)
