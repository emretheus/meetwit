# ADR-0004 — Calendar integration (read-only) — implementation spec

- **Status**: Proposed
- **Date**: 2026-05-21
- **Deciders**: @emretheus
- **Pillar**: 1 of 3 (see `docs/INTEGRATIONS_ROADMAP.md`). Foundation for ADR-0005 (auto-detect)
  and ADR-0006 (diarization).
- **Provider order**: Google Calendar first, Microsoft Graph as a follow-on (§11).

## Context

Today every Meetwit note is born as "Untitled meeting" with no idea what it is, who's in it,
or what it's about. Otter/Fireflies feel smart because they pull this from the user's calendar.
We can match that **without** a server-side bot and **without** audio leaving the device:
read-only calendar access is the user's own data, fetched on-device, cached locally.

This spec is buildable as written: exact endpoints, schema, OAuth flow, Rust commands, frontend
components, error cases, and a phased task list.

## Decision summary

- Add **read-only** OAuth (`calendar.readonly`) for Google. Tokens stored in the **macOS
  Keychain** via a new Rust command surface (never localStorage, never server-side).
- Rust core runs the OAuth **loopback redirect** flow (not deep-link) and owns token storage +
  refresh. The Python sidecar never sees the user's Google credentials — Rust fetches calendar
  data and the sidecar only stores the resulting event cache.
- New SQLite tables `calendar_account` + `calendar_event`, and a `Meeting.calendar_event_id` FK.
- New FastAPI router `calendar.py` exposing the event cache + the link-to-meeting operation.
- Home shows **Today's meetings**; one click starts a recording pre-named from the event;
  the live Copilot gets the event agenda as context.

---

## 1. Privacy posture (non-negotiable constraints)

These constraints bound every design choice below:

1. **Read-only scope only.** `https://www.googleapis.com/auth/calendar.readonly`. We never
   request write scopes. No bot, no event creation, no RSVP.
2. **Audio still never leaves the device.** Calendar integration touches metadata only.
3. **Tokens live in the macOS Keychain**, owned by the Rust core. Not in SQLite, not in
   localStorage, not sent to the Python sidecar.
4. **Google credentials never reach the sidecar.** Rust performs the token exchange + the
   Calendar API calls, then hands *event data* (not tokens) to the sidecar for caching.
5. **User-revocable + local-wipe.** Disconnecting deletes the Keychain token and purges the
   `calendar_account` + `calendar_event` rows.
6. Update `docs/PRIVACY.md` with a "Calendar" subsection stating the above, and surface a
   one-line version in the connect UI.

---

## 2. OAuth 2.0 flow (Google, loopback redirect with PKCE)

We use the **loopback IP redirect** flow — Google's recommended flow for desktop apps — with
**PKCE** (no client secret shipped in the binary; desktop apps are "public clients").

### Sequence

```
 User clicks "Connect Google Calendar" (Settings)
        │
        ▼
 [Rust] generate code_verifier + code_challenge (S256) AND a 128-bit `state` nonce
 [Rust] bind a transient listener on 127.0.0.1 ONLY (never 0.0.0.0) → <random free port>
 [Rust] open system browser to:
        https://accounts.google.com/o/oauth2/v2/auth
          ?client_id=<MEETWIT_GOOGLE_OAUTH_CLIENT_ID>
          &redirect_uri=http://127.0.0.1:<port>
          &response_type=code
          &scope=https://www.googleapis.com/auth/calendar.readonly
          &code_challenge=<challenge>&code_challenge_method=S256
          &state=<128-bit nonce>
          &access_type=offline&prompt=consent
        │
        ▼
 User consents in browser → Google redirects to 127.0.0.1:<port>/?code=...&state=...
        │
        ▼
 [Rust] loopback listener accepts ONLY `GET /` whose `state` exactly matches the
        nonce generated above (reject otherwise — see CSRF note); captures `code`,
        returns a tiny "you can close this tab" HTML page
 [Rust] POST https://oauth2.googleapis.com/token
          grant_type=authorization_code, code, code_verifier, client_id, redirect_uri
        → { access_token, refresh_token, expires_in, scope }
        │
        ▼
 [Rust] store refresh_token + account email in Keychain (service="meetwit.calendar.google")
 [Rust] call sidecar POST /calendar/accounts to register the connected account (email + provider)
        │
        ▼
 [Rust] emit Tauri event "calendar-connected" → frontend refreshes Settings + Home
```

### Why loopback over deep-link

- No custom URL scheme registration; works in dev and packaged builds identically.
- `tauri-plugin-deep-link` is not a dependency; loopback avoids adding it.
- The loopback listener is short-lived (bound only during the consent flow, then dropped).

### CSRF / authorization-code-injection (MANDATORY)

The loopback redirect is reachable by **any** local process or a malicious page,
so the `code` must be bound to *our* in-flight request. PKCE protects the token
exchange but does **not** prevent an attacker injecting their own `code` — the
`state` nonce does.

- Generate a 128-bit random `state`, store it alongside the `code_verifier`, and
  send it on the auth URL.
- The loopback listener MUST reject any redirect whose `state` doesn't match
  (and only accept `GET /`). Without this, the flow is vulnerable to login-CSRF /
  authorization-code injection.
- Bind the listener to `127.0.0.1` explicitly, never `0.0.0.0`. A local process
  can still race for the random port between bind and browser-open — the `state`
  check is the real mitigation, so it is non-optional.
- On `invalid_grant` (revoked), clear BOTH the in-memory access token and the
  Keychain refresh token.

### Client ID handling

- The OAuth **client_id** for a desktop "public client" is not a secret; ship it via config:
  `Settings.google_oauth_client_id` (env `MEETWIT_GOOGLE_OAUTH_CLIENT_ID`, see `config.py`).
  PKCE replaces the client secret, so nothing sensitive is embedded.
- For dev, the developer registers a Google Cloud OAuth client (type "Desktop app") and sets
  the env var.

### Token refresh

- Access tokens expire (~1h). Before each calendar fetch, Rust checks expiry; if stale, POST
  the refresh_token to the token endpoint and update the cached access token (in-memory, not
  Keychain — only the refresh_token persists in Keychain).
- If refresh returns `invalid_grant` (revoked/expired), mark the account disconnected and emit
  `calendar-disconnected` so the UI prompts a reconnect.

---

## 3. Data model + migration

New migration: `0004_calendar.py`, `down_revision = "0003_meeting_summary_md"`.

### `calendar_account`

```python
class CalendarAccount(Base):
    __tablename__ = "calendar_accounts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    provider: Mapped[str] = mapped_column(String(16))          # "google" | "microsoft"
    email: Mapped[str] = mapped_column(String(255), index=True)
    scopes: Mapped[str] = mapped_column(Text)                  # space-joined granted scopes
    connected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # NOTE: no token columns. Tokens live in the macOS Keychain, keyed by (provider, email).
    events: Mapped[list["CalendarEvent"]] = relationship(
        back_populates="account", cascade="all, delete-orphan"
    )
```

### `calendar_event` (local cache)

```python
class CalendarEvent(Base):
    __tablename__ = "calendar_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("calendar_accounts.id", ondelete="CASCADE"), index=True
    )
    external_id: Mapped[str] = mapped_column(String(255), index=True)   # provider event id
    title: Mapped[str | None] = mapped_column(String(512))
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    attendees: Mapped[str | None] = mapped_column(Text)        # JSON: [{name,email,organizer}]
    description: Mapped[str | None] = mapped_column(Text)       # agenda
    conference_url: Mapped[str | None] = mapped_column(Text)    # parsed Zoom/Meet/Teams link
    conference_kind: Mapped[str | None] = mapped_column(String(16))  # zoom|meet|teams|null
    meeting_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("meetings.id", ondelete="SET NULL"), nullable=True, index=True
    )
    account: Mapped[CalendarAccount] = relationship(back_populates="events")
    __table_args__ = (UniqueConstraint("account_id", "external_id", name="uq_event_per_account"),)
```

### `Meeting` extension

```python
# in Meeting:
calendar_event_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
```

Migration adds the column via `op.batch_alter_table("meetings")` (matches the `0003` pattern).
The two new tables use `op.create_table(...)` (matches `0002`).

### Conference URL parsing

A helper `parse_conference_url(event)` scans the event's `location` + `description` +
`conferenceData` for known patterns:
- `https://*.zoom.us/j/...` → kind `zoom`
- `https://meet.google.com/...` → kind `meet`
- `https://teams.microsoft.com/l/meetup-join/...` → kind `teams`

Stored on the cached event; consumed by ADR-0005 (auto-detect) later.

---

## 4. Backend API — `routers/calendar.py`

New router, registered in `main.py` alongside the others:
`from meetwit.routers import calendar; app.include_router(calendar.router)`.

Follows the existing pattern: `router = APIRouter(prefix="", tags=["calendar"])`, helpers
`_engine(request)`, `async with Session(engine)`.

### `POST /calendar/accounts` — register a connected account (called by Rust post-OAuth)

Request:
```json
{ "provider": "google", "email": "user@gmail.com", "scopes": "https://www.googleapis.com/auth/calendar.readonly" }
```
Response `CalendarAccountOut`:
```json
{ "id": "uuid", "provider": "google", "email": "user@gmail.com", "connected_at": "ISO8601", "last_synced_at": null }
```
Upserts on `(provider, email)`.

### `GET /calendar/accounts` — list connected accounts

Response: `CalendarAccountOut[]`.

### `DELETE /calendar/accounts/{id}` — disconnect

Cascade-deletes the account's cached events. Returns `{ "deleted": "<id>" }`. (Rust separately
deletes the Keychain token — see §5.)

### `POST /calendar/events/sync` — upsert a batch of fetched events (called by Rust)

Rust fetches from Google, normalizes, and posts the batch. The sidecar only persists; it never
calls Google.

Request:
```json
{
  "account_id": "uuid",
  "events": [
    {
      "external_id": "abc123",
      "title": "Q1 Planning",
      "starts_at": "2026-05-21T14:00:00Z",
      "ends_at": "2026-05-21T15:00:00Z",
      "attendees": [{"name":"Sarah Chen","email":"sarah@x.com","organizer":true}],
      "description": "Agenda: roadmap, hiring, budget",
      "conference_url": "https://meet.google.com/abc-defg-hij",
      "conference_kind": "meet"
    }
  ]
}
```
Response: `{ "upserted": <int>, "account_id": "uuid" }`. Upsert keyed on
`(account_id, external_id)`; updates `last_synced_at`.

### `GET /calendar/events?from=ISO&to=ISO` — read the cache for a window

Used by Home's "Today" section. Defaults to today (local-day bounds) if params omitted.
Response `CalendarEventOut[]`:
```json
[{
  "id": "uuid", "title": "Q1 Planning",
  "starts_at": "...", "ends_at": "...",
  "attendees": [...], "description": "...",
  "conference_url": "...", "conference_kind": "meet",
  "meeting_id": null
}]
```

### `POST /calendar/events/{id}/link` — link an event to a (new) meeting

Called when the user clicks "Record" on an event. Behavior:
- Creates a `Meeting` with `title` = event title, `project` = null, `calendar_event_id` = event id.
- Sets `calendar_event.meeting_id` to the new meeting.
- Returns the created `MeetingSummary` so the frontend can start recording against it.

Request: `{}` (id in path). Response: `MeetingSummary` (existing model).

### Pydantic models

Mirror the existing style in `meetings.py` (explicit fields, `from_attributes` where reading
ORM rows). `attendees` serialized as a typed list, not a raw string, at the API boundary.

---

## 5. Rust core — commands + OAuth + Keychain

New module `src-tauri/src/calendar/mod.rs` + commands in `commands.rs`, registered in the
`tauri::generate_handler![]` in `lib.rs`.

### New dependency

- A Keychain crate (e.g. `keyring = "3"`) for secure refresh-token storage. Service name
  `"meetwit.calendar.google"`, account = the user's email.
- `reqwest` (already present) for the token exchange + Calendar API.
- A tiny loopback HTTP listener — can be a minimal `tokio` TCP accept loop (avoid adding a web
  framework just for one redirect).

### Commands

```rust
/// Run the full OAuth loopback flow. On success: stores refresh token in Keychain,
/// registers the account with the sidecar, emits "calendar-connected", returns the email.
#[tauri::command]
pub async fn calendar_connect_google(app: AppHandle, state: State<'_, AppState>) -> Result<String, String>;

/// Fetch today's (or a window's) events from Google using the stored token, normalize,
/// and POST them to the sidecar's /calendar/events/sync. Returns the count synced.
#[tauri::command]
pub async fn calendar_sync(state: State<'_, AppState>, account_id: String) -> Result<u32, String>;

/// Delete the Keychain token + ask the sidecar to delete the account row.
#[tauri::command]
pub async fn calendar_disconnect(state: State<'_, AppState>, account_id: String, email: String) -> Result<(), String>;
```

All return `Result<_, String>` per the existing convention. The browser is opened with the
existing `std::process::Command::new("open").arg(url)` pattern already used for system-settings
deep-links in `commands.rs`.

### Sync scheduling

- Sync on: app launch (if an account exists), on `calendar-connected`, and on a low-frequency
  timer (e.g. every 10 min) while the app is open. Window fetched: `now - 1h` .. `now + 12h`
  (enough for "today" + the immediate next meetings).
- Errors during background sync are logged, not surfaced as toasts (silent retry), except
  `invalid_grant` which flips the account to "needs reconnect."

---

## 6. Frontend

### API layer (`lib/backend.ts`)

Add typed wrappers matching the new endpoints, following the `jsonFetch<T>` pattern:
```ts
export interface CalendarEventOut {
  id: string; title: string | null;
  starts_at: string; ends_at: string | null;
  attendees: Array<{ name: string | null; email: string | null; organizer: boolean }>;
  description: string | null;
  conference_url: string | null;
  conference_kind: 'zoom' | 'meet' | 'teams' | null;
  meeting_id: string | null;
}
export function listCalendarEvents(fromISO?: string, toISO?: string): Promise<CalendarEventOut[]>;
export function linkEventToMeeting(eventId: string): Promise<Meeting>;
export function listCalendarAccounts(): Promise<CalendarAccountOut[]>;
```
The OAuth connect/disconnect/sync go through Tauri `invoke()` (Rust commands), not `jsonFetch`.

### Settings — "Calendar" card

- "Connect Google Calendar" button → `invoke('calendar_connect_google')`.
- Connected state: account email, "Last synced …", "Sync now" + "Disconnect" buttons.
- Microsoft row shown as "Coming soon" until §11.

### Home — "Today" section

- New component `TodayMeetings.tsx`, rendered above/around the welcome hero (when calendar
  connected). Lists upcoming + in-progress events with: time, title, attendee avatars/initials,
  a conference-kind chip (Meet/Zoom/Teams), and a **Record** button.
- **Record** → `linkEventToMeeting(event.id)` → set the returned meeting active in the store →
  `startMeeting()` in place (reuses the existing record-in-place flow from the recent Home
  redesign). The note is pre-named from the event.
- If an event already has `meeting_id`, show "Open note" instead of "Record."
- Empty/disconnected state: a subtle "Connect your calendar to see today's meetings" prompt
  linking to Settings.

### Live/summary header — event context

- When `meeting.calendar_event_id` is set, show the event title + an attendees chip in the
  header (the `LiveMeetingView` top bar).

### Copilot agenda context

- When asking, if the meeting has a linked event with a `description`, the frontend passes it
  (or the backend joins it) so `live_ask` can prepend an "AGENDA:" block to the prompt — lets
  the Copilot answer "what from the agenda haven't we covered?"

---

## 7. Error & edge cases

| Case | Handling |
| --- | --- |
| User closes the consent tab without granting | Loopback listener times out (e.g. 120s) → command returns `Err("cancelled")`; UI shows "Connection cancelled." |
| `invalid_grant` on refresh (revoked) | Mark account needs-reconnect; emit `calendar-disconnected`; Home hides "Today," Settings shows "Reconnect." |
| No `MEETWIT_GOOGLE_OAUTH_CLIENT_ID` configured | Connect button disabled with tooltip "Calendar not configured in this build." |
| Event with no conference link | `conference_url`/`conference_kind` null; still recordable; auto-detect (ADR-0005) just won't have a URL to match. |
| All-day events | Excluded from the "Today" recordable list (filter where it has a start time-of-day). |
| Recurring events | Google expands instances when `singleEvents=true` is requested; we request that so each instance is a distinct cached event. |
| Two accounts, overlapping events | Cache keyed per `(account_id, external_id)`; Home merges + sorts by `starts_at`. |
| Offline | Home reads the local cache (last sync); shows a "last synced …" hint; no error. |
| Time zones | Store all timestamps UTC (matches `_now()` convention); convert to local only for display. |

---

## 8. Test plan

- **Backend (pytest):** event upsert idempotency on `(account_id, external_id)`; `link` creates
  a meeting + back-links the event; `GET /calendar/events` window filtering; cascade delete on
  account removal. Mock the sidecar-facing endpoints — no Google calls in tests (Rust owns those).
- **Rust:** PKCE challenge generation (verifier→S256 challenge correctness); loopback redirect
  parses `code`; token-refresh request shape. Keychain store/load round-trip behind a trait so
  it can be mocked in CI (CI has no Keychain).
- **Conference URL parser:** unit tests for Zoom/Meet/Teams patterns + the no-link case.
- **Frontend (typecheck/lint/build):** the new wrappers + components compile under strict TS.
- **Manual:** connect a real Google account in dev; verify Today shows real events; Record
  pre-names the note; disconnect wipes events + Keychain token.

---

## 9. Phased task breakdown

**Phase A — schema + sidecar API (no UI):**
1. Migration `0004_calendar.py` (two tables + `meetings.calendar_event_id`).
2. ORM models `CalendarAccount`, `CalendarEvent`; `Meeting.calendar_event_id`.
3. `routers/calendar.py` endpoints (§4) + Pydantic models; register in `main.py`.
4. `parse_conference_url` helper + tests.
5. pytest for upsert / link / window / cascade.

**Phase B — Rust OAuth + Keychain + sync:**
6. Add `keyring` dep; `calendar/mod.rs` with PKCE + loopback + token exchange/refresh.
7. Commands `calendar_connect_google`, `calendar_sync`, `calendar_disconnect`; register in `lib.rs`.
8. `Settings.google_oauth_client_id` in `config.py`; document dev setup in `BUILDING.md`.
9. Background sync timer + launch sync.

**Phase C — frontend:**
10. `lib/backend.ts` wrappers + `invoke` calls.
11. Settings "Calendar" card.
12. Home `TodayMeetings.tsx` + Record→link→start-in-place wiring.
13. Header event context + Copilot agenda passthrough.

**Phase D — polish + privacy:**
14. Error/edge handling (§7), disconnect wipe, needs-reconnect state.
15. `docs/PRIVACY.md` calendar subsection + connect-UI privacy line.
16. Full verification: pytest, ruff, cargo clippy, frontend typecheck/lint/build.

---

## 10. Estimated effort

**Medium** — ~3–4 focused build sessions. Phase B (OAuth loopback + Keychain + refresh) is the
riskiest/most novel; everything else follows existing repo patterns closely.

## 11. Microsoft Graph follow-on

Once Google ships, add Microsoft behind the same `provider` field:
- Scope `Calendars.Read`, endpoint `GET /me/calendarView?startDateTime=&endDateTime=`.
- Same loopback PKCE flow against `login.microsoftonline.com`.
- `conferenceData` → Teams URL parsing already covered by `parse_conference_url`.
- The sidecar tables + frontend are provider-agnostic already; only a second Rust connect
  command + a Graph normalizer are new.

## Consequences

- **Positive**: closes the biggest context gap vs. competitors; unlocks ADR-0005 + ADR-0006;
  stays fully local-capture + read-only.
- **Negative**: first feature to require OAuth + Keychain + a shipped (non-secret) client id;
  adds the `keyring` dependency and a Google Cloud project to the build prerequisites.
- **Neutral**: introduces a provider abstraction we'll lean on for Microsoft.
