# ADR-0006 — Speaker diarization ("who said what") — implementation spec

- **Status**: Proposed
- **Date**: 2026-05-21
- **Deciders**: @emretheus
- **Pillar**: 3 of 3 (see `docs/INTEGRATIONS_ROADMAP.md`).
- **Best built after**: ADR-0004 (calendar) — attendees turn "Speaker 1" into real names.

## Context

The transcript today is one **unattributed wall of text**. Every competitor labels speakers;
it's table-stakes for a transcript anyone wants to read or share, and it's the single biggest
*perceived quality* upgrade. The data model is already prepared: `Transcript.speaker`
(`backend/src/meetwit/models.py:83`) exists and is currently always `null` — we just need to
populate it, fully on-device.

## Decision summary

- Run **`pyannote.audio`** diarization in the Python sidecar on the **saved meeting WAV**
  (`Meeting.audio_path`, persisted today per GAP-11) — **post-meeting**, not live (live
  diarization is much harder and lower accuracy; deferred).
- Align diarization speaker-turns to the existing whisper transcript segments by time overlap,
  and write the dominant speaker into `Transcript.speaker`.
- Provide a **name-assignment** UI: map "Speaker 1 → Sarah Chen" (seeded from calendar
  attendees when ADR-0004 is present); names propagate to transcript, summary, and Copilot.
- Runs locally; no audio leaves the device — consistent with the privacy stance.

---

## 1. Privacy + scope

- **On-device only.** pyannote runs in the local sidecar against the locally-stored WAV. No
  audio leaves the machine.
- **Model distribution** is the one open question (§9): pyannote's pipeline uses gated Hugging
  Face models. Either bundle them in the .app (bigger install) or fetch on first use (like the
  Whisper models). Recommendation in §9.
- **Post-meeting only** in this ADR. Live/streaming diarization is explicitly out of scope.

---

## 2. New dependencies (sidecar)

Current sidecar ML deps: `sentence-transformers` only (no `torch`, no `pyannote`).

- `pyannote.audio` (the diarization pipeline) — pulls in **`torch`** (large; this materially
  increases the sidecar footprint and cold-start).
- Models: `pyannote/speaker-diarization-3.1` (or current) — segmentation + embedding +
  clustering. Gated on HF (license acceptance).

Because `torch` is heavy, gate diarization behind a feature/flag so users who don't want the
footprint aren't forced to download it (see §9 distribution).

---

## 3. Pipeline

```
 Meeting stops → WAV saved at Meeting.audio_path (existing, GAP-11)
        │
        ▼  (user clicks "Identify speakers" OR auto after stop if enabled)
 [sidecar] load WAV → pyannote diarization pipeline
        → speaker turns: [(start, end, "SPEAKER_00"), (start, end, "SPEAKER_01"), ...]
        │
        ▼
 [sidecar] align with existing transcripts (by time overlap, §4)
        → each Transcript row gets a dominant speaker label
        │
        ▼
 [sidecar] write Transcript.speaker = "Speaker 1" | "Speaker 2" | ...
        │
        ▼
 [frontend] show speaker labels; offer name-assignment (seed from calendar attendees)
        │
        ▼
 [sidecar] on name assignment, remap labels → real names across transcript (+ summary regen)
```

### Two modes

- **Manual (recommended default):** a "Identify speakers" action on the summary page runs the
  pipeline on demand. Predictable cost, user-initiated.
- **Auto-on-stop (opt-in pref):** like the existing `autoSummary`, run diarization automatically
  after a recording stops. Off by default given the compute cost.

---

## 4. Alignment algorithm (whisper ↔ pyannote)

pyannote yields speaker-labeled time ranges; whisper yields text segments with `audio_start` /
`audio_end` (already stored on `Transcript`). For each transcript segment:

1. Find all diarization turns overlapping `[audio_start, audio_end]`.
2. Assign the speaker whose overlap **duration** is largest (dominant speaker).
3. If no overlap (rare; silence/edge), inherit the previous segment's speaker or leave null.

Map pyannote's raw `SPEAKER_00/01/...` to friendly, stable `Speaker 1 / Speaker 2 / …` ordered
by first appearance. Persist the raw→friendly map on the meeting so re-runs stay consistent.

This time-overlap alignment is the finicky engineering bit — unit-test it with synthetic
turn/segment fixtures (§7).

---

## 5. Data model

`Transcript.speaker` already exists — no migration needed for the core feature.

Add a small mapping store so name assignments survive and re-runs are stable. Two options:
- **(a) JSON on the meeting:** add `Meeting.speaker_map` (`Text`, JSON:
  `{"Speaker 1": "Sarah Chen", ...}`) via a tiny `0005_speaker_map.py` migration
  (`op.batch_alter_table("meetings")`, matching the `0003` pattern).
- **(b) dedicated `speaker` table** keyed by meeting. Heavier; only needed if we later add
  cross-meeting voice identity (§ out-of-scope).

Recommendation: **(a)** for v1 — minimal, matches the existing additive-column pattern.

---

## 6. Backend API — additions to `routers/post_meeting.py` (or a new `diarization` router)

Mirrors the existing long-running-process pattern (the summary/index endpoints already return a
`process_id` the frontend polls via `indexProgress`).

### `POST /meetings/{id}/diarize` — run diarization

- Requires `Meeting.audio_path` to exist (else 400 "no audio for this meeting").
- Kicks off the pipeline as a tracked process; returns `{ "process_id": "..." }`.
- On completion: `Transcript.speaker` populated; a default `speaker_map` (Speaker 1..N) saved.
- Frontend polls the existing progress endpoint.

### `PUT /meetings/{id}/speaker-map` — assign real names

Request:
```json
{ "map": { "Speaker 1": "Sarah Chen", "Speaker 2": "Marco" } }
```
Behavior: persists `Meeting.speaker_map`; the API serves transcripts with names resolved (or the
frontend resolves client-side from the map). Optionally triggers a summary regen so the summary
uses real names. Response: updated `MeetingSummary`.

### Transcript responses

Existing transcript responses already include `speaker` (it was just always null). No shape
change — it now carries data. The frontend resolves `speaker` through `speaker_map` for display.

---

## 7. Frontend

### Summary/live transcript rendering

- Render the `speaker` label as a chip before each line (the live `LiveMeetingView` and the
  summary transcript already render timestamp chips — add a speaker chip next to it).
- Color-code speakers consistently (hash the label → a palette slot).

### "Identify speakers" action

- A toolbar button on the summary page transcript pane: "Identify speakers" →
  `POST /meetings/{id}/diarize`, show progress (reuse the existing poll/toast pattern from
  summary generation), refresh transcripts on done.

### Name-assignment panel

- After diarization, a small panel lists detected speakers with a dropdown per speaker:
  - Options seeded from the linked calendar event's attendees (ADR-0004) + free-text entry.
  - Save → `PUT /meetings/{id}/speaker-map` → labels become names everywhere.

### Prefs

- `autoDiarize: boolean` (default false) in `UserPrefs` — run automatically on stop.

---

## 8. Error & edge cases

| Case | Handling |
| --- | --- |
| No `audio_path` (audio not saved) | 400 + UI explains "Enable 'Save audio' to identify speakers." (ties to the existing `saveAudio` pref.) |
| Single speaker | pyannote returns one cluster → all lines "Speaker 1"; name-assignment still offered. |
| Over/under-clustering (wrong speaker count) | Allow the user to merge labels in the assignment UI (map two "Speaker N" to the same name). |
| Very long meeting | pyannote scales with audio length; run async + show progress; consider a max-duration guard. |
| Model not downloaded | If fetch-on-first-use (§9): prompt to download (like Whisper models) before first run. |
| `torch` not installed (lite build) | Feature hidden/disabled with "Speaker ID not available in this build." |
| Re-run diarization | Re-aligns + rewrites `speaker`; preserves existing name map by stable Speaker N ordering. |
| Whisper/pyannote timestamp drift | Dominant-overlap assignment tolerates small drift; segments with no overlap inherit previous speaker. |

---

## 9. Open question — model distribution (decide before build)

- **Bundle in .app**: larger install (~hundreds of MB with torch + models), zero first-run
  latency, fully offline immediately.
- **Fetch on first use** (like Whisper models today): smaller base install, a one-time download
  with a progress UI, requires network once.

**Recommendation:** fetch-on-first-use, matching the existing Whisper-model download UX, and gate
the whole feature (including `torch`) so the base app stays lean for users who never use it.

---

## 10. Test plan

- **Alignment unit tests (Python):** synthetic pyannote turns + whisper segments → assert the
  dominant-overlap speaker assignment; edge cases (no overlap, exact ties, single speaker).
- **Speaker-map remap:** assigning names rewrites display correctly; stable Speaker N ordering
  across re-runs.
- **API:** `diarize` requires `audio_path`; `speaker-map` persists + optionally regens summary.
- **Frontend:** transcript renders speaker chips; assignment panel seeds from attendees.
- **Manual:** record a 2-person conversation → "Identify speakers" → two speakers detected →
  assign names → names appear in transcript + (regenerated) summary.

---

## 11. Phased task breakdown

**Phase A — pipeline + alignment (backend, behind a flag):**
1. Add `pyannote.audio` (+ `torch`) as an optional/gated dependency; model fetch helper.
2. Diarization service: WAV → speaker turns.
3. Alignment algorithm (§4) + unit tests.
4. `POST /meetings/{id}/diarize` (tracked process) writing `Transcript.speaker`.
5. Migration `0005_speaker_map.py` (`Meeting.speaker_map`).

**Phase B — naming + frontend:**
6. `PUT /meetings/{id}/speaker-map` + optional summary regen.
7. Transcript speaker chips (live + summary) with consistent coloring.
8. "Identify speakers" action + progress (reuse poll/toast).
9. Name-assignment panel, seeded from calendar attendees (ADR-0004).
10. `autoDiarize` pref + Settings toggle.

**Phase C — distribution + polish:**
11. Model fetch-on-first-use UX (matching Whisper-model download).
12. Lite-build gating (feature hidden when torch absent).
13. Full verification: pytest (alignment), ruff, frontend typecheck/lint/build; manual 2-speaker test.

---

## 12. Estimated effort

**Medium–High.** The biggest "this looks like a real product" payoff, but pyannote is heavy
(torch + gated models) and the whisper↔diarization alignment needs care. Best sequenced last so
calendar attendee names already exist to label speakers.

## Consequences

- **Positive**: transforms the transcript from a wall of text into an attributed, shareable,
  professional artifact; enriches summaries and Copilot answers with who-said-what; uses the
  already-present `Transcript.speaker` field.
- **Negative**: materially larger footprint (`torch`); gated HF models add a setup/distribution
  step; alignment is the trickiest engineering of the three pillars.
- **Neutral**: introduces a per-meeting `speaker_map` and an optional auto-on-stop pref.
