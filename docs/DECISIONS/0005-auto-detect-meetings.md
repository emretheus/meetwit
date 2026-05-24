# ADR-0005 — Auto-detect meetings (nudge to record) — implementation spec

- **Status**: Proposed
- **Date**: 2026-05-21
- **Deciders**: @emretheus
- **Pillar**: 2 of 3 (see `docs/INTEGRATIONS_ROADMAP.md`).
- **Depends on**: nothing for the app-detection half; the calendar-nudge half builds on
  ADR-0004 (calendar cache + `conference_url`).

## Context

The #1 way a meeting note-taker fails its user is the user **forgetting to hit record**. A
gentle, local nudge — "Looks like you're in a meeting, want to record?" — removes that failure
mode. This is fully local (process + audio detection on-device, plus the local calendar cache);
no bot, no cloud.

## Decision summary

- Detect when a conferencing app (Zoom / Google Meet / Microsoft Teams) is **running with an
  active audio session**, and surface a native macOS notification offering one-click record.
- Optionally (with ADR-0004) fire a **calendar-time nudge** at/just-before an event's start,
  pre-named from the event.
- **Always a nudge, never auto-start** — recording requires an explicit user click (consent).
- Per-app + global "don't ask" preferences; respects the existing compliance banner.

---

## 1. Hard guardrails (consent + trust)

1. **Never auto-record.** Detection only ever *offers*. The user clicks "Record." Two-party-
   consent jurisdictions make silent auto-recording a legal liability.
2. **Debounce + de-dupe.** One nudge per detected meeting session, not a stream of them. If the
   user dismisses, don't re-nudge for that session.
3. **Respect "don't ask."** Per-app toggle ("don't ask for Zoom again") + a global off switch in
   Settings.
4. **No content inspection.** We detect *that* a conferencing app is active and *that* audio is
   flowing — never *what* is said, until the user opts in to record.
5. The existing compliance banner (GAP-6, shown on record start) still applies once recording
   begins.

---

## 2. Detection signals (macOS)

Two independent signals; a nudge fires when **both** agree there's a live meeting (reduces false
positives like Zoom sitting idle in the tray).

### Signal A — conferencing process running

Enumerate running applications and match known bundle ids / process markers:

| App | Marker |
| --- | --- |
| Zoom | bundle id `us.zoom.xos` |
| Microsoft Teams | bundle id `com.microsoft.teams2` (and legacy `com.microsoft.teams`) |
| Google Meet (desktop PWA) | Chrome/Edge app process for `meet.google.com` |
| Google Meet (browser tab) | harder — see §6 "tab detection limitation" |

Implementation: from the Rust core, list running apps. The simplest robust path is
`NSWorkspace.runningApplications` via an Objective-C bridge, or shelling to `lsappinfo` /
`ps`. Poll on a **low cadence** (every ~5s) — negligible CPU.

### Signal B — active audio session

We already capture system audio via ScreenCaptureKit; an active output/input audio session is a
natural extension to query. A meeting is "live" when there is sustained audio activity (not a
one-off system sound). Use a short rolling window (e.g. audio active for ≥ 3s).

### Calendar signal (with ADR-0004)

Independently of A/B: when a cached `calendar_event.starts_at` arrives (± a small window) and the
event has a `conference_url`, fire a calendar nudge. This catches the case where the user is
*about* to join. If A/B also fire, prefer the calendar nudge (it has the title/agenda).

---

## 3. State machine

```
            ┌─────────┐  appProcess && audioActive (≥3s)   ┌────────────┐
   IDLE ───►│ DETECTED │──────────────────────────────────►│  NUDGED    │
            └─────────┘                                     └────────────┘
                ▲                                            │  │   │
                │ session ends (app quits / audio silent)    │  │   └─ user clicks "Record" → start in place → RECORDING
                └────────────────────────────────────────────┘  └───── user dismisses → SUPPRESSED (no re-nudge this session)
```

- A "session" is keyed by (app, start-of-activity). It ends when the app quits **or** audio has
  been silent for a cooldown (e.g. 60s).
- `SUPPRESSED` and `RECORDING` both prevent further nudges for the current session.
- Calendar nudges are keyed by `external_id` so each event nudges at most once.

---

## 4. Rust core — detection + notification

New module `src-tauri/src/detect/mod.rs`. Runs a background task while the app is open.

### New dependency

- `tauri-plugin-notification` (v2) for native macOS notifications + action buttons. (Currently
  only `tauri-plugin-shell` is present.)

### Behavior

- A `tokio` interval task (5s) evaluates Signal A + Signal B, advances the state machine.
- On `IDLE → NUDGED`, post a notification:
  - Title: `"Recording available"` (app nudge) or the event title (calendar nudge).
  - Body: `"You're in a Zoom call — record it with Meetwit?"`.
  - Actions: **Record** / **Dismiss**. (macOS notification action buttons via the plugin.)
- **Record** → focus the window, emit Tauri event `nudge-accepted` with a payload describing the
  source (`{ kind: "app"|"calendar", appId?, eventId? }`); the frontend starts recording
  in place (linking the calendar event when present, reusing ADR-0004's link flow).
- **Dismiss** → state → `SUPPRESSED`.

### Commands / events

```rust
/// Enable/disable detection at runtime (mirrors the Settings toggle).
#[tauri::command]
pub fn detection_set_enabled(state: State<'_, AppState>, enabled: bool) -> Result<(), String>;

/// Add/remove an app from the per-app suppression list.
#[tauri::command]
pub fn detection_suppress_app(state: State<'_, AppState>, app_id: String, suppress: bool) -> Result<(), String>;
```

Emitted events: `nudge-accepted` (payload above), consumed by the frontend.

---

## 5. Frontend

### Prefs (`lib/prefs.ts`)

Extend `UserPrefs`:
```ts
autoDetect: boolean;            // master switch, default true
autoDetectSuppressed: string[]; // app ids the user said "don't ask" for
calendarNudge: boolean;         // default true (only meaningful with ADR-0004)
```
Load/save via the existing `getPrefs`/`savePrefs`. On change, call `detection_set_enabled` /
`detection_suppress_app` so Rust stays in sync.

### Settings — "Auto-detect" card

- Master toggle "Offer to record when a meeting starts."
- Sub-toggle "Use calendar to remind me" (disabled/greyed unless a calendar is connected).
- A list of suppressed apps with "re-enable" buttons.

### Nudge-accept handler (app root)

- Listen for `nudge-accepted` in `__root.tsx` (alongside the existing `onTranscriptUpdate`
  subscription).
- On accept: if `kind === "calendar"`, `linkEventToMeeting(eventId)` then start; else
  `createMeeting({})` then start. Navigate to `/` (the in-place recording surface) and call
  `startMeeting()`.

---

## 6. Error & edge cases

| Case | Handling |
| --- | --- |
| Zoom open but idle (no call) | Signal B (audio) gates it out — no nudge until audio is active. |
| Meet in a **browser tab** | macOS can't easily tell which tab a browser is showing. v1 covers the Meet **desktop app** + audio-active browser heuristic; pure-tab Meet detection is a known limitation (document it; calendar nudge covers it when ADR-0004 is present). |
| User already recording | State machine never nudges while `RECORDING`. |
| Multiple meetings back-to-back | Session ends on audio-silence cooldown; the next call is a new session → eligible for a fresh nudge. |
| Notification permission denied (macOS) | Detection still runs; fall back to an in-app banner on Home instead of a system notification. Prompt for permission on first enable. |
| Detection disabled | Background task idles (no polling) until re-enabled. |
| App-detection without Screen Recording / audio permission | Signal A still works; Signal B degrades — fall back to app-only detection with a higher confidence bar (e.g. require the app to be frontmost). |
| Calendar event with no `conference_url` | No calendar nudge (we only nudge for events that look like real calls); app-detection may still fire. |

---

## 7. Test plan

- **Rust:** state-machine transitions (IDLE→DETECTED→NUDGED→SUPPRESSED/RECORDING) as pure
  unit tests with injected signals; session-end on audio-silence; calendar-nudge de-dupe by
  `external_id`. Bundle-id matching table tested.
- **Frontend:** prefs round-trip; `nudge-accepted` handler starts the right meeting (mock
  `invoke`/events).
- **Manual:** start a real Zoom/Meet call in dev → nudge appears; click Record → recording
  starts in place; Dismiss → no re-nudge for that call; toggle off in Settings → no nudges.

---

## 8. Phased task breakdown

**Phase A — app + audio detection (no calendar dependency):**
1. Add `tauri-plugin-notification`; `detect/mod.rs` with the polling task + state machine.
2. Signal A (running-app match) + Signal B (audio-active) wired to the existing audio capture.
3. Notification with Record/Dismiss actions; emit `nudge-accepted`.
4. Commands `detection_set_enabled` / `detection_suppress_app`; register in `lib.rs`.
5. Frontend: prefs fields, Settings "Auto-detect" card, `nudge-accepted` handler in `__root.tsx`.
6. Unit tests (state machine, bundle ids) + manual Zoom/Meet test.

**Phase B — calendar nudge (requires ADR-0004):**
7. Read the local `calendar_event` cache; fire a time-based nudge for events with a
   `conference_url`; de-dupe by `external_id`.
8. Calendar-nudge → `linkEventToMeeting` path on accept.
9. "Use calendar to remind me" sub-toggle.

---

## 9. Estimated effort

**Low–Medium.** Phase A is small and independent — shippable on its own and immediately useful.
Phase B is a thin layer on ADR-0004.

## Consequences

- **Positive**: removes the most common failure mode (forgetting to record); cheap; fully local.
- **Negative**: macOS process/audio detection is somewhat heuristic; browser-tab Meet is a known
  gap until calendar nudges exist. Adds the notification plugin + a background polling task.
- **Neutral**: introduces a small client-side state machine + new prefs surface.
