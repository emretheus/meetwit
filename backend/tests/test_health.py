"""Smoke test — the sidecar boots and /health returns ok."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from meetwit import __version__
from meetwit.main import create_app


@pytest.mark.asyncio
async def test_health_endpoint() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload == {"ok": True, "version": __version__}


@pytest.mark.asyncio
async def test_version_endpoint() -> None:
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/version")

    assert response.status_code == 200
    assert response.json() == {"version": __version__}
