"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from meetwit import __version__
from meetwit.config import Settings, get_settings
from meetwit.db import make_engine, run_migrations
from meetwit.indexing import Embedder
from meetwit.llm import OllamaProvider
from meetwit.routers import (
    calendar,
    folders,
    knowledge,
    meetings,
    memory,
    notes,
    post_meeting,
)

log = structlog.get_logger()


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    log.info("sidecar.startup", version=__version__, port=settings.port)
    run_migrations(settings.db_path)
    app.state.engine = make_engine(settings.db_path)
    app.state.embedder = Embedder()
    app.state.llm = OllamaProvider(settings.ollama_url)
    try:
        yield
    finally:
        if engine := getattr(app.state, "engine", None):
            await engine.dispose()
        log.info("sidecar.shutdown")


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the FastAPI app. ``settings`` defaults to the environment."""
    settings = settings or get_settings()

    app = FastAPI(
        title="Meetwit Sidecar",
        version=__version__,
        docs_url="/docs",
        redoc_url=None,
        lifespan=_lifespan,
    )
    app.state.settings = settings

    # CORS — the Tauri WebView runs at a different origin (tauri://localhost
    # in production, http://localhost:1420 in `tauri:dev`) than the sidecar,
    # so the browser issues OPTIONS preflights on POST/PATCH/DELETE. Without
    # CORS middleware FastAPI returns 405 and the request is blocked.
    # Sidecar is bound to 127.0.0.1 already (loopback only), so allow_origins=*
    # here doesn't expand attack surface — only loopback-local processes can
    # reach this port in the first place.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "version": __version__}

    @app.get("/version")
    async def version() -> dict[str, str]:
        return {"version": __version__}

    app.include_router(knowledge.router)
    app.include_router(memory.router)
    app.include_router(meetings.router)
    app.include_router(post_meeting.router)
    app.include_router(calendar.router)
    app.include_router(notes.router)
    app.include_router(folders.router)
    return app


app = create_app()
