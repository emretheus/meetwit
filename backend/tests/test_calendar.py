"""Calendar integration (ADR-0004) — sidecar API + parser tests.

Builds a lightweight app with only the calendar + meetings routers wired to a
freshly-migrated tmp SQLite DB, so we avoid loading the heavy Embedder/LLM that
the real lifespan constructs. No Google calls are made anywhere — Rust owns
those; the sidecar only persists/serves.
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from meetwit.calendar_util import parse_conference_url
from meetwit.db import make_engine
from meetwit.routers import calendar, meetings


def _migrate(db_path: Path) -> None:
    """Run Alembic against a specific tmp DB.

    NOTE: we shell out with ``-x db_path=`` (like test_schema.py) rather than
    calling ``db.run_migrations`` — env.py resolves the DB path from the
    -x argument, and ignores the config's sqlalchemy.url, so the in-process
    helper would migrate the *real* app DB instead of the tmp one.
    """
    backend_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-x", f"db_path={db_path}", "upgrade", "head"],
        cwd=backend_root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"alembic failed:\n{result.stdout}\n{result.stderr}"


@pytest_asyncio.fixture()
async def client(tmp_path: Path) -> AsyncIterator[AsyncClient]:
    db_path = tmp_path / "cal.sqlite"
    _migrate(db_path)
    engine = make_engine(db_path)

    app = FastAPI()
    app.state.engine = engine
    app.include_router(meetings.router)
    app.include_router(calendar.router)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    await engine.dispose()


async def _connect_account(client: AsyncClient, email: str = "u@gmail.com") -> str:
    r = await client.post(
        "/calendar/accounts",
        json={
            "provider": "google",
            "email": email,
            "scopes": "https://www.googleapis.com/auth/calendar.readonly",
        },
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _event(external_id: str, *, hours_from_now: float = 1.0, all_day: bool = False) -> dict:
    start = datetime.now(UTC) + timedelta(hours=hours_from_now)
    return {
        "external_id": external_id,
        "title": f"Event {external_id}",
        "starts_at": start.isoformat(),
        "ends_at": (start + timedelta(hours=1)).isoformat(),
        "all_day": all_day,
        "attendees": [{"name": "Sarah Chen", "email": "sarah@x.com", "organizer": True}],
        "description": "Agenda: roadmap",
        "conference_url": "https://meet.google.com/abc-defg-hij",
        "conference_kind": "meet",
    }


# ─── parse_conference_url ─────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("fields", "expected"),
    [
        (
            ("https://meet.google.com/abc-defg-hij",),
            ("https://meet.google.com/abc-defg-hij", "meet"),
        ),
        (
            ("Join https://acme.zoom.us/j/9999?pwd=x",),
            ("https://acme.zoom.us/j/9999?pwd=x", "zoom"),
        ),
        (
            ("https://teams.microsoft.com/l/meetup-join/xyz",),
            ("https://teams.microsoft.com/l/meetup-join/xyz", "teams"),
        ),
        ((None, "no conference link in here"), (None, None)),
        (("",), (None, None)),
    ],
)
def test_parse_conference_url(fields: tuple, expected: tuple) -> None:
    assert parse_conference_url(*fields) == expected


def test_parse_conference_url_strips_trailing_punctuation() -> None:
    url, kind = parse_conference_url("link: <https://meet.google.com/xyz-abcd-efg>")
    assert url == "https://meet.google.com/xyz-abcd-efg"
    assert kind == "meet"


# ─── Account lifecycle ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_account_upsert_is_idempotent(client: AsyncClient) -> None:
    id1 = await _connect_account(client)
    id2 = await _connect_account(client)  # same (provider, email)
    assert id1 == id2  # upsert, not duplicate

    accounts = (await client.get("/calendar/accounts")).json()
    assert len(accounts) == 1


# ─── Event sync ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_event_sync_upsert_idempotent_on_external_id(client: AsyncClient) -> None:
    account_id = await _connect_account(client)

    r1 = await client.post(
        "/calendar/events/sync",
        json={"account_id": account_id, "events": [_event("e1"), _event("e2")]},
    )
    assert r1.json()["upserted"] == 2

    # Re-sync the SAME external ids (e1 retitled) + one new → no duplicates.
    e1_updated = _event("e1")
    e1_updated["title"] = "Renamed e1"
    r2 = await client.post(
        "/calendar/events/sync",
        json={"account_id": account_id, "events": [e1_updated, _event("e3")]},
    )
    assert r2.json()["upserted"] == 2

    events = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    titles = {e["title"] for e in events}
    assert titles == {"Renamed e1", "Event e2", "Event e3"}  # e1 updated in place


@pytest.mark.asyncio
async def test_sync_parses_conference_url_when_missing(client: AsyncClient) -> None:
    account_id = await _connect_account(client)
    ev = _event("e1")
    ev["conference_url"] = None
    ev["conference_kind"] = None
    ev["description"] = "Dial in at https://acme.zoom.us/j/55555"
    await client.post("/calendar/events/sync", json={"account_id": account_id, "events": [ev]})

    events = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    assert events[0]["conference_url"] == "https://acme.zoom.us/j/55555"
    assert events[0]["conference_kind"] == "zoom"


# ─── Window read ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_events_excludes_all_day(client: AsyncClient) -> None:
    account_id = await _connect_account(client)
    await client.post(
        "/calendar/events/sync",
        json={
            "account_id": account_id,
            "events": [_event("timed"), _event("allday", all_day=True)],
        },
    )
    events = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    titles = {e["title"] for e in events}
    assert "Event timed" in titles
    assert "Event allday" not in titles  # all-day excluded


@pytest.mark.asyncio
async def test_list_events_window_filters(client: AsyncClient) -> None:
    account_id = await _connect_account(client)
    await client.post(
        "/calendar/events/sync",
        json={
            "account_id": account_id,
            "events": [_event("soon", hours_from_now=1), _event("far", hours_from_now=48)],
        },
    )
    events = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    titles = {e["title"] for e in events}
    assert titles == {"Event soon"}  # "far" (48h out) is outside the window


# ─── Link to meeting ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_starts_at_normalized_to_utc(client: AsyncClient) -> None:
    """An event with a tz offset must round-trip as the same UTC instant, with
    an explicit offset in the response — otherwise time-based reminders skew."""
    account_id = await _connect_account(client)
    ev = _event("tz")
    # 14:30 at +02:00 == 12:30 UTC.
    ev["starts_at"] = "2026-05-22T14:30:00+02:00"
    ev["ends_at"] = "2026-05-22T15:30:00+02:00"
    await client.post("/calendar/events/sync", json={"account_id": account_id, "events": [ev]})

    out = (
        await client.get(
            "/calendar/events",
            params={
                "from": "2026-05-22T00:00:00Z",
                "to": "2026-05-23T00:00:00Z",
            },
        )
    ).json()
    assert len(out) == 1
    parsed = datetime.fromisoformat(out[0]["starts_at"])
    assert parsed.tzinfo is not None  # carries a tz, not naive
    assert parsed.astimezone(UTC) == datetime(2026, 5, 22, 12, 30, tzinfo=UTC)


@pytest.mark.asyncio
async def test_link_creates_and_backlinks_meeting(client: AsyncClient) -> None:
    account_id = await _connect_account(client)
    await client.post(
        "/calendar/events/sync", json={"account_id": account_id, "events": [_event("e1")]}
    )
    events = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    event_id = events[0]["id"]

    r = await client.post(f"/calendar/events/{event_id}/link")
    assert r.status_code == 200, r.text
    meeting = r.json()
    assert meeting["title"] == "Event e1"  # pre-named from the event
    assert meeting["status"] == "recording"
    meeting_id = meeting["id"]

    # Event is now back-linked.
    events2 = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    assert events2[0]["meeting_id"] == meeting_id

    # Re-linking returns the SAME meeting (no duplicate).
    r2 = await client.post(f"/calendar/events/{event_id}/link")
    assert r2.json()["id"] == meeting_id


@pytest.mark.asyncio
async def test_deleting_meeting_unlinks_calendar_event(client: AsyncClient) -> None:
    """A cached event whose meeting was deleted must become recordable again
    (meeting_id cleared) — otherwise the Home row shows a dead 'Open note'."""
    window = {
        "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
        "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
    }
    account_id = await _connect_account(client)
    await client.post(
        "/calendar/events/sync", json={"account_id": account_id, "events": [_event("e1")]}
    )
    event_id = (await client.get("/calendar/events", params=window)).json()[0]["id"]

    meeting_id = (await client.post(f"/calendar/events/{event_id}/link")).json()["id"]
    # Sanity: linked.
    assert (await client.get("/calendar/events", params=window)).json()[0][
        "meeting_id"
    ] == meeting_id

    # Delete the meeting → the event's meeting_id must be cleared.
    assert (await client.delete(f"/meetings/{meeting_id}")).status_code == 200
    after = (await client.get("/calendar/events", params=window)).json()
    assert after[0]["meeting_id"] is None  # recordable again, no dead link


@pytest.mark.asyncio
async def test_link_missing_event_404(client: AsyncClient) -> None:
    r = await client.post("/calendar/events/does-not-exist/link")
    assert r.status_code == 404


# ─── Disconnect cascade ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_disconnect_cascades_events(client: AsyncClient) -> None:
    account_id = await _connect_account(client)
    await client.post(
        "/calendar/events/sync",
        json={"account_id": account_id, "events": [_event("e1"), _event("e2")]},
    )
    r = await client.delete(f"/calendar/accounts/{account_id}")
    assert r.json() == {"deleted": account_id}

    assert (await client.get("/calendar/accounts")).json() == []
    events = (
        await client.get(
            "/calendar/events",
            params={
                "from": (datetime.now(UTC) - timedelta(hours=2)).isoformat(),
                "to": (datetime.now(UTC) + timedelta(hours=12)).isoformat(),
            },
        )
    ).json()
    assert events == []  # cascade-deleted with the account
