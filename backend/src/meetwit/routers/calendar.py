"""Read-only calendar integration (ADR-0004) — sidecar API.

The sidecar persists and serves calendar data only; it never talks to Google /
Microsoft and never sees OAuth tokens. The Rust core runs the OAuth loopback
flow, owns the Keychain token, fetches events, and POSTs the normalized batch
here. Endpoints:

  POST   /calendar/accounts            register/upsert a connected account (Rust)
  GET    /calendar/accounts            list connected accounts
  DELETE /calendar/accounts/{id}       disconnect (cascade-deletes cached events)
  POST   /calendar/events/sync         batch-upsert fetched events (Rust)
  GET    /calendar/events?from=&to=    read the cache for a window (Home "Today")
  POST   /calendar/events/{id}/link    create a meeting from an event + back-link
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, time, timedelta
from typing import Literal

import structlog
from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from meetwit.calendar_util import parse_conference_url
from meetwit.models import CalendarAccount, CalendarEvent, Meeting
from meetwit.routers.meetings import MeetingSummary, _meeting_summary

log = structlog.get_logger()
router = APIRouter(prefix="", tags=["calendar"])

Provider = Literal["google", "microsoft"]
ConferenceKind = Literal["zoom", "meet", "teams"]

# Module-level Query singletons (ruff B008: don't call Query in arg defaults).
_FROM_Q = Query(default=None, alias="from")
_TO_Q = Query(default=None)


# ─── Helpers ─────────────────────────────────────────────────────────────


def Session(engine: AsyncEngine) -> AsyncSession:  # noqa: N802 — mirrors meetings.py
    return AsyncSession(engine, expire_on_commit=False)


def _engine(request: Request) -> AsyncEngine:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="db engine not initialized",
        )
    return engine  # type: ignore[no-any-return]


def _to_utc(dt: datetime | None) -> datetime | None:
    """Convert to UTC for consistent storage/comparison. A tz-aware datetime is
    converted; a naive one is assumed to already be UTC (defensive — Google
    sends offsets, so this normally doesn't trigger)."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


# ─── Pydantic schemas ────────────────────────────────────────────────────


class Attendee(BaseModel):
    name: str | None = None
    email: str | None = None
    organizer: bool = False


class CalendarAccountIn(BaseModel):
    provider: Provider
    email: str = Field(max_length=255)
    scopes: str = Field(max_length=2_000)


class CalendarAccountOut(BaseModel):
    id: str
    provider: str
    email: str
    connected_at: str
    last_synced_at: str | None = None


class CalendarEventIn(BaseModel):
    external_id: str = Field(max_length=255)
    title: str | None = Field(default=None, max_length=512)
    starts_at: datetime
    ends_at: datetime | None = None
    all_day: bool = False
    attendees: list[Attendee] = Field(default_factory=list)
    description: str | None = Field(default=None, max_length=20_000)
    conference_url: str | None = Field(default=None, max_length=4_096)
    conference_kind: ConferenceKind | None = None


class EventSyncBatch(BaseModel):
    account_id: str
    # Bound the batch so one request can't enqueue an unbounded write workload.
    events: list[CalendarEventIn] = Field(default_factory=list, max_length=2_000)


class CalendarEventOut(BaseModel):
    id: str
    title: str | None
    starts_at: str
    ends_at: str | None
    all_day: bool
    attendees: list[Attendee]
    description: str | None
    conference_url: str | None
    conference_kind: str | None
    meeting_id: str | None


def _account_out(a: CalendarAccount) -> CalendarAccountOut:
    return CalendarAccountOut(
        id=a.id,
        provider=a.provider,
        email=a.email,
        connected_at=a.connected_at.isoformat(),
        last_synced_at=a.last_synced_at.isoformat() if a.last_synced_at else None,
    )


def _iso_utc(dt: datetime | None) -> str | None:
    """ISO-8601 with an explicit UTC offset. Values come back from SQLite naive
    (no tz column); we stored them as UTC, so stamp UTC on the way out so the
    Rust/JS consumers parse an unambiguous instant."""
    if dt is None:
        return None
    aware = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
    return aware.isoformat()


def _event_out(e: CalendarEvent) -> CalendarEventOut:
    raw = json.loads(e.attendees) if e.attendees else []
    attendees = [Attendee(**a) for a in raw] if isinstance(raw, list) else []
    return CalendarEventOut(
        id=e.id,
        title=e.title,
        starts_at=_iso_utc(e.starts_at) or "",
        ends_at=_iso_utc(e.ends_at),
        all_day=e.all_day,
        attendees=attendees,
        description=e.description,
        conference_url=e.conference_url,
        conference_kind=e.conference_kind,
        meeting_id=e.meeting_id,
    )


# ─── Accounts ────────────────────────────────────────────────────────────


@router.post("/calendar/accounts", response_model=CalendarAccountOut)
async def register_account(body: CalendarAccountIn, request: Request) -> CalendarAccountOut:
    """Upsert a connected account on (provider, email). Called by Rust after a
    successful OAuth handshake — carries no token, only the account identity."""
    engine = _engine(request)
    async with Session(engine) as session:
        existing = (
            await session.execute(
                select(CalendarAccount).where(
                    CalendarAccount.provider == body.provider,
                    CalendarAccount.email == body.email,
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.scopes = body.scopes
            existing.connected_at = datetime.now(UTC)
            account = existing
        else:
            account = CalendarAccount(
                provider=body.provider,
                email=body.email,
                scopes=body.scopes,
                connected_at=datetime.now(UTC),
            )
            session.add(account)
        await session.commit()
        await session.refresh(account)
        return _account_out(account)


@router.get("/calendar/accounts", response_model=list[CalendarAccountOut])
async def list_accounts(request: Request) -> list[CalendarAccountOut]:
    engine = _engine(request)
    async with Session(engine) as session:
        rows = await session.execute(
            select(CalendarAccount).order_by(CalendarAccount.connected_at.asc())
        )
        return [_account_out(a) for a in rows.scalars().all()]


@router.delete("/calendar/accounts/{account_id}")
async def disconnect_account(account_id: str, request: Request) -> dict[str, object]:
    """Disconnect: cascade-deletes the account's cached events. Rust separately
    deletes the Keychain refresh token."""
    engine = _engine(request)
    async with Session(engine) as session:
        a = await session.get(CalendarAccount, account_id)
        if a is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="account not found")
        await session.delete(a)
        await session.commit()
    return {"deleted": account_id}


# ─── Events ──────────────────────────────────────────────────────────────


@router.post("/calendar/events/sync")
async def sync_events(body: EventSyncBatch, request: Request) -> dict[str, object]:
    """Batch-upsert fetched events keyed on (account_id, external_id), and bump
    the account's last_synced_at. Called by Rust after a Google fetch."""
    engine = _engine(request)
    async with Session(engine) as session:
        account = await session.get(CalendarAccount, body.account_id)
        if account is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="account not found")

        # Index existing rows by external_id for in-place update.
        existing_rows = (
            (
                await session.execute(
                    select(CalendarEvent).where(CalendarEvent.account_id == body.account_id)
                )
            )
            .scalars()
            .all()
        )
        by_ext = {e.external_id: e for e in existing_rows}

        upserted = 0
        for ev in body.events:
            url: str | None = ev.conference_url
            kind: str | None = ev.conference_kind
            # Fallback parse only when Rust didn't already resolve the link.
            if url is None:
                url, kind = parse_conference_url(ev.title, ev.description)
            attendees_json = json.dumps([a.model_dump() for a in ev.attendees])

            row = by_ext.get(ev.external_id)
            if row is None:
                row = CalendarEvent(account_id=body.account_id, external_id=ev.external_id)
                session.add(row)
            row.title = ev.title
            # Normalize to UTC before storing. SQLite has no native tz type, so
            # a tz-aware datetime would otherwise be persisted as naive local
            # wall-clock and lose its offset — which then reads back ambiguous
            # and skews time-based comparisons (calendar reminders, windowing).
            row.starts_at = _to_utc(ev.starts_at)
            row.ends_at = _to_utc(ev.ends_at)
            row.all_day = ev.all_day
            row.attendees = attendees_json
            row.description = ev.description
            row.conference_url = url
            row.conference_kind = kind
            upserted += 1

        account.last_synced_at = datetime.now(UTC)
        await session.commit()
    return {"upserted": upserted, "account_id": body.account_id}


@router.get("/calendar/events", response_model=list[CalendarEventOut])
async def list_events(
    request: Request,
    from_: datetime | None = _FROM_Q,
    to: datetime | None = _TO_Q,
) -> list[CalendarEventOut]:
    """Read the local cache for a time window. Defaults to today (local-day
    bounds). All-day events are excluded — they aren't recordable meetings."""
    engine = _engine(request)
    if from_ is None or to is None:
        # Local-day bounds. Server runs on the user's Mac, so "now" local is right.
        now_local = datetime.now()
        start = datetime.combine(now_local.date(), time.min)
        end = start + timedelta(days=1)
        from_ = from_ or start.astimezone(UTC)
        to = to or end.astimezone(UTC)

    async with Session(engine) as session:
        rows = await session.execute(
            select(CalendarEvent)
            .where(
                CalendarEvent.starts_at >= from_,
                CalendarEvent.starts_at < to,
                CalendarEvent.all_day.is_(False),
            )
            .order_by(CalendarEvent.starts_at.asc())
        )
        return [_event_out(e) for e in rows.scalars().all()]


@router.post("/calendar/events/{event_id}/link", response_model=MeetingSummary)
async def link_event(event_id: str, request: Request) -> MeetingSummary:
    """Create a Meeting from a cached event (pre-named from the event) and
    back-link the event. Called when the user clicks Record on a Today row.

    Idempotent-ish: if the event is already linked to a meeting, returns that
    meeting instead of creating a duplicate."""
    engine = _engine(request)
    async with Session(engine) as session:
        ev = await session.get(CalendarEvent, event_id)
        if ev is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="event not found")

        if ev.meeting_id is not None:
            existing = await session.get(Meeting, ev.meeting_id)
            if existing is not None:
                return _meeting_summary(existing, transcript_count=0)

        meeting = Meeting(
            title=ev.title,
            started_at=datetime.now(UTC),
            status="recording",
            calendar_event_id=ev.id,
        )
        session.add(meeting)
        await session.flush()  # populate meeting.id for the back-link
        ev.meeting_id = meeting.id
        await session.commit()
        await session.refresh(meeting)
        return _meeting_summary(meeting, transcript_count=0)
