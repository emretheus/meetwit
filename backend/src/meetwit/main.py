"""FastAPI application factory."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI

from meetwit import __version__
from meetwit.config import Settings, get_settings

log = structlog.get_logger()


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = app.state.settings
    log.info("sidecar.startup", version=__version__, port=settings.port)
    yield
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

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"ok": True, "version": __version__}

    @app.get("/version")
    async def version() -> dict[str, str]:
        return {"version": __version__}

    return app


app = create_app()
