# Meetwit — Integrations & Intelligence Roadmap

> Status: EXPLORATORY · 2026-05-21
> Scope: how Meetwit competes with Otter / Fireflies / Fathom **without** abandoning its
> local-first, privacy-preserving identity.
> Nothing here is committed — this is the strategic frame + sequencing document.
>
> **Detailed, buildable specs per pillar** (exact APIs, schema, OAuth flow, Rust commands,
> frontend, error cases, phased task lists):
> - Pillar 1 — Calendar: [`docs/DECISIONS/0004-calendar-integration.md`](DECISIONS/0004-calendar-integration.md)
> - Pillar 2 — Auto-detect: [`docs/DECISIONS/0005-auto-detect-meetings.md`](DECISIONS/0005-auto-detect-meetings.md)
> - Pillar 3 — Diarization: [`docs/DECISIONS/0006-speaker-diarization.md`](DECISIONS/0006-speaker-diarization.md)

---

## 1. The strategic frame

### How the incumbents actually work

There are two fundamentally different capture models in this market, and they have very
different costs and trade-offs:

| Model | Who | How it works | Requires |
| --- | --- | --- | --- |
| **Bot-join** | Fireflies, Otter, Fathom, Read.ai | A server-side bot is invited (via calendar) as a *participant*. It joins the meeting URL, captures the cloud A/V stream, transcribes server-side. | Cloud backend, headless meeting bots, OAuth, **audio leaves the user's device** |
| **Local-capture** | Granola, Superwhisper, **Meetwit** | Captures system audio + mic on the user's own machine. No bot joins; nothing leaves the device. | On-device audio capture (already built) |

### Why Meetwit should NOT chase bot-join

Meetwit's entire pitch is *"privacy-first — everything stays on your Mac"* (see
`docs/PRIVACY.md`, `docs/THREAT_MODEL.md`). A bot-join architecture **directly contradicts
that**:

- It needs a cloud backend running headless browsers — operationally heavy and expensive.
- The meeting audio necessarily leaves the user's device to a server we operate.
- It introduces a third party into the call (the bot is a visible participant), which has
  consent and trust implications.

Competing with Fireflies *on their turf* means becoming a worse Fireflies. The winning move
is to be the **best private, local alternative** — the Granola playbook (a local-capture
note-taker now valued at $250M+). We beat them on the one axis they can't match: *your data
never leaves your machine.*

### Where the real gap is

The incumbents don't feel magical because of the bot. They feel magical because they have
**context** the meeting just *appears* knowing what it is, who's in it, and what it's about,
and afterward it *goes somewhere useful*. Meetwit today has none of that: meetings appear as
"Untitled meeting," speakers are unattributed, and notes don't connect to the user's
calendar or downstream tools.

**Everything in this roadmap closes that context gap while staying 100% local-capture.**

---

## 2. The three pillars (priority order)

All three preserve the local/private identity. Recommended build sequence:

1. **Calendar integration** — the foundation. Unlocks naming, agenda context, and attendee
   names (which the other two pillars consume).
2. **Auto-detect meetings** — cheap, high daily value, removes the "I forgot to record" failure.
3. **Speaker diarization** — highest effort, highest perceived-quality jump; best *after*
   calendar exists to supply real names.

---

## 3. Pillar 1 — Calendar integration (read-only)

### Why it's the highest-leverage feature

The single biggest UX delta vs. competitors. Today every note is "Untitled meeting" and the
Copilot has zero idea what the meeting is supposed to be about. Calendar context fixes all of
that at once.

### What it delivers

- **Today's meetings on Home** — a list with times, titles, attendees. One click →
  start recording, pre-named from the event with attendees attached.
- **Auto-name + auto-tag notes** — the meeting `title` and `project` fields populate from the
  calendar event instead of "Untitled meeting." (`Meeting.title`, `Meeting.project` already
  exist — see `backend/src/meetwit/models.py:45-46`.)
- **Agenda context for the Copilot** — if the event has a description/agenda, feed it into the
  live-ask system prompt so the AI knows what *should* be covered ("we still haven't discussed
  X from the agenda").
- **Attendee list** — becomes the candidate name pool for diarization (Pillar 3).

### Privacy posture (critical)

- **Read-only OAuth scope only** (`calendar.readonly` / Graph `Calendars.Read`). We never
  write to the calendar, never post a bot, never stream audio anywhere.
- The *only* thing that leaves the device is the OAuth handshake + the calendar fetch with
  Google/Microsoft. Event data is cached **locally** (SQLite), encrypted tokens stored on
  device. This is defensible against the "nothing leaves your Mac" promise: calendar metadata
  is the user's own data, fetched read-only, and audio still never leaves.
- Document this explicitly in `docs/PRIVACY.md` and surface it in the connect-flow UI ("We
  read your calendar to name and contextualize meetings. We never write to it, and your audio
  never leaves this Mac.").

### Technical design

**OAuth in a Tauri desktop app** — this is the fiddly part. Two viable flows:

1. **Loopback redirect (recommended):** spin up a transient `localhost:<port>` listener in the
   Rust core, open the system browser to the provider's consent screen with
   `redirect_uri=http://127.0.0.1:<port>/callback`, capture the `code` on the loopback, exchange
   for tokens. This is Google's recommended desktop flow and avoids needing a custom URL scheme.
2. **Deep-link (`meetwit://` custom scheme):** requires registering a URL scheme + adding
   `tauri-plugin-deep-link` (not currently a dependency — `Cargo.toml` only has
   `tauri-plugin-shell`). More setup; loopback is simpler for a single-window desktop app.

**Token storage:** use the macOS Keychain (via a Rust keychain crate) for the refresh token,
not localStorage/plaintext. Access tokens are short-lived; refresh on demand.

**Providers:**
- Google Calendar API (`GET /calendar/v3/calendars/primary/events`, `timeMin`/`timeMax` for today).
- Microsoft Graph (`GET /me/calendarview`) for Outlook/Microsoft 365.
- Start with Google (largest overlap with Meet users), add Microsoft second.

**Data model additions (new Alembic migration):**
- New `calendar_account` table: provider, account email, encrypted-token reference, scopes.
- New `calendar_event` cache table: external id, start/end, title, attendees (JSON), description,
  meeting URL (Zoom/Meet/Teams link parsed from location/description), and a nullable
  `meeting_id` FK once a recording is linked.
- Extend `Meeting` with `calendar_event_id` (nullable) so a note knows its source event.

**Frontend:**
- Settings → "Connect calendar" card (OAuth trigger, connected-account display, disconnect).
- Home → "Today" section above/around the welcome hero: upcoming + in-progress events with a
  "Record" button each.
- Live/summary header → show linked event title + attendees chip.

**Build cost:** **Medium.** OAuth loopback + token storage is the main effort; the rest is a
calendar poll + UI. ~1–2 focused build sessions.

---

## 4. Pillar 2 — Auto-detect meetings

### Why

The #1 reason note-takers fail their users is the user **forgetting to hit record**. A gentle,
local nudge removes that failure mode entirely — and it's cheap to build.

### What it delivers

- **Conferencing-app detection:** notice when Zoom, Google Meet (browser tab or the Meet
  desktop app), or Microsoft Teams is running *and* an audio session is active, then surface a
  native notification: "Looks like you're in a meeting — start recording?"
- **Calendar-triggered nudge** (depends on Pillar 1): when a calendar event's start time
  arrives, notify "Your 2:00 PM standup is starting — record?" pre-named from the event.
- **One-click start** from either nudge → jumps straight into the in-place recording surface.

### Technical design

- **Process detection (macOS):** enumerate running applications (bundle ids `us.zoom.xos`,
  `com.microsoft.teams2`, browser processes) and check for an active audio session. Can be done
  from the Rust core; poll on a low cadence (every few seconds) to keep CPU negligible.
- **Audio-activity gate:** we already capture system audio via ScreenCaptureKit — detecting an
  active output/input session is a natural extension. Only nudge when there's actual audio, not
  just an app sitting idle.
- **Calendar trigger:** a lightweight scheduler that fires N minutes before / at event start
  (reads the local `calendar_event` cache from Pillar 1).
- **Notifications:** macOS native notification (add `tauri-plugin-notification`), click → focus
  window + pre-fill the recording.

### Important guardrails

- **Always a nudge, never an auto-start.** Recording without explicit user action has legal
  consent implications in two-party-consent jurisdictions. The user must click "Record."
- Make the nudge dismissible and add a "don't ask for this app again" preference.
- Respect the existing compliance banner (already shown on record start — see GAP-6 in the gap
  analysis).

### Build cost

**Low–Medium.** The Zoom/Meet/Teams process-detection path is independent of everything else
and quick to ship. The calendar-triggered nudge layers on top of Pillar 1.

---

## 5. Pillar 3 — Speaker diarization ("who said what")

### Why

Today the transcript is one **unattributed wall of text**. Every competitor labels speakers;
it's table-stakes for a transcript anyone wants to read or share. This is the single biggest
*perceived quality* upgrade — it's what makes a transcript look professional.

The data model is **already ready for it:** `Transcript.speaker` exists
(`backend/src/meetwit/models.py:83`) and is currently always null. We just need to populate it.

### What it delivers

- Transcript lines labeled **Speaker 1 / Speaker 2 / …** with consistent identity across the
  meeting.
- **Real names** when calendar attendees exist (Pillar 1): map "Speaker 1" → "Sarah Chen" via a
  one-time per-meeting assignment UI, or heuristically when an attendee count matches.
- Names carried into the **summary + action items** ("**Sarah** committed to shipping by Friday")
  and into the **Copilot** answers — dramatically richer than "someone said."

### Technical design

- **`pyannote.audio`** in the Python sidecar — the standard local diarization pipeline. Runs
  fully on-device (consistent with privacy stance). Requires a model download (gated HF model;
  bundle or fetch on first use) and `torch` (heavier sidecar footprint — currently the sidecar
  has `sentence-transformers` but not `torch`/`pyannote`).
- **Alignment:** diarization produces speaker-labeled time segments; whisper produces
  text segments with timestamps. Align by overlapping time ranges and assign each transcript
  segment its dominant speaker. This timestamp alignment is the finicky engineering part.
- **Two modes:**
  - **Post-meeting (recommended first):** run diarization on the saved WAV
    (`Meeting.audio_path` already persisted — see GAP-11) after stop. Higher accuracy, no
    real-time pressure. Fits the existing `retranscribe_file` pattern.
  - **Live (later):** streaming diarization is much harder and lower accuracy; defer.
- **Name-assignment UI:** a small panel on the summary page — "Speaker 1 = ?" dropdown
  populated from calendar attendees, persisted so the labels propagate everywhere.

### Build cost

**Medium–High.** pyannote is heavy (model + torch + CPU/GPU), and whisper↔diarization timestamp
alignment needs care. Highest effort of the three, but the biggest "this looks like a real
product" payoff. Best built *after* Pillar 1 so attendee names exist.

---

## 6. Recommended sequencing & rationale

```
Pillar 1: Calendar (read-only)        ──► foundation; unlocks the other two
        │
        ├─► Pillar 2: Auto-detect      ──► cheap, daily value, uses calendar triggers
        │
        └─► Pillar 3: Diarization      ──► highest effort; uses attendees for real names
```

1. **Calendar first.** Auto-naming + agenda context make the app instantly feel smart, and it
   produces the attendee data the other pillars consume.
2. **Auto-detect second.** The process-detection half is independent and quick; the
   calendar-nudge half layers cleanly onto Pillar 1.
3. **Diarization last.** Highest effort, and meaningfully *better* once calendar attendees can
   turn "Speaker 1" into real names.

---

## 7. Explicitly out of scope (and why)

| Not building | Reason |
| --- | --- |
| **Bot-join (server-side meeting bot)** | Requires cloud backend + audio leaving the device. Breaks the core privacy promise. Don't compete with Fireflies on their turf. |
| **Write-access calendar** | Read-only is enough for context. Write access expands the trust surface for no proportional benefit. |
| **Auto-post to Slack/email without review** | Distribution should stay human-in-the-loop. Auto-posting AI summaries to colleagues is a trust/accuracy liability. |
| **Live (real-time) diarization** | Much harder, lower accuracy. Post-meeting diarization on the saved WAV is the right first step. |
| **Auto-start recording (no user click)** | Legal consent implications. Always nudge, never auto-record. |

---

## 8. New dependencies this roadmap would introduce

| Dependency | For | Notes |
| --- | --- | --- |
| `tauri-plugin-notification` | Pillar 2 nudges | Native macOS notifications |
| `tauri-plugin-deep-link` *(maybe)* | Pillar 1 OAuth | Only if we choose deep-link over loopback redirect |
| macOS Keychain crate (Rust) | Pillar 1 token storage | Encrypted refresh-token storage |
| `pyannote.audio` + `torch` | Pillar 3 | Heavy; sizable sidecar footprint increase |
| Google Calendar / MS Graph client | Pillar 1 | Plain HTTPS; can use existing `reqwest` |

Current Tauri plugins: only `tauri-plugin-shell`. Current Python ML deps:
`sentence-transformers` (no `torch`/`pyannote` yet).

---

## 9. Open questions for product

- **Which calendar first** — Google (more Meet overlap) vs. Microsoft (more enterprise)?
  Recommendation: Google first.
- **Diarization model distribution** — bundle the (large) pyannote model in the app, or fetch
  on first use like the Whisper models? Affects install size vs. first-run latency.
- **How aggressive should auto-detect be** — only calendar-triggered, only app-detection, or
  both? Recommendation: ship app-detection first (no calendar dependency), add calendar nudges
  with Pillar 1.
- **Name persistence** — should "Speaker 1 = Sarah" assignments persist across meetings (voice
  fingerprint) or be per-meeting only? Cross-meeting voice ID is a much bigger lift; start
  per-meeting.

---

*This document is exploratory and intentionally non-committal. It exists to align on direction
before any implementation. Once a pillar is greenlit, it should get its own design doc under
`docs/DECISIONS/` with the concrete API + migration spec.*
