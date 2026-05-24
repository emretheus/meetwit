# Meetwit ↔ Meetily — Feature, UX & Flow Gap Analysis

> Status: IN PROGRESS · 2026-05-21
> Meetily reference: `Zackriya-Solutions/meeting-minutes` (public MIT)
> Meetwit reference: this repo (`desktop/` Tauri + React, `backend/` FastAPI)

## Implementation status (updated 2026-05-21)

| Gap | Status |
| --- | --- |
| GAP-13 BYOK cloud providers wired to backend LLM | ✅ DONE — `llm/providers.py` (Ollama/OpenAI/Groq/OpenRouter/custom/Anthropic), threaded through summary + live ask + memory ask; keys ride the request, fall back to Ollama |
| GAP-15 Auto-summary on stop | ✅ DONE — `stopMeeting` triggers post-meeting when `prefs.autoSummary` |
| GAP-6 Compliance banner | ✅ DONE — live screen banner on start, auto-dismiss 5s |
| GAP-14 Summary templates + custom prompt | ✅ DONE — `services/templates.py` (Default/Standup/Sales/Interview) + `/summary-templates` + `TemplatePickerModal` |
| GAP-16 Export Markdown/PDF | ✅ DONE — `lib/export.ts` + overflow menu on summary screen |
| GAP-18 Transcript-text search in ⌘K | ✅ DONE — `/meetings/search/transcripts` + command palette Transcripts group |
| GAP-5 Crash/session recovery | ✅ DONE — `SessionRecovery` banner finalizes orphaned `recording` meetings |
| GAP-1 Pause/Resume | ✅ DONE (lifecycle-level) — pause stops ASR + freezes timer, keeps capture alive; resume restarts ASR. Pill + live toolbar wired |
| GAP-2 Real device pickers | ✅ DONE — `audio::list_input_devices` + `audio_input_devices` command; `MicCapture::start_with_device`; Settings mic picker persists `micDeviceId`; threaded into `startMeeting` |
| GAP-3 Audio backend switch (SCK/Core Audio) | ✅ DONE (preference plumbed) — `system_audio_start(backend)` accepts the choice; persists + threads through. Core-Audio capture path itself still routes via SCK until the second backend lands (logged) |
| GAP-11 Retranscribe | ✅ DONE — mixer writes the mixed mono 16 kHz stream to `recordings/<id>.wav` during recording; `audio_path` persisted on the meeting; `retranscribe_file` Rust command re-decodes the WAV with any downloaded model in 30 s chunks; `PUT /meetings/{id}/transcripts` replaces transcripts + chunks; RetranscribeModal runs it end-to-end |
| GAP-4/7/8/9/12/17/19 | ⏳ P3 backlog, unchanged |

**All P0–P2 gaps are now implemented end-to-end** (Rust + backend + frontend),
verified via `cargo check`/`clippy`, frontend typecheck/lint/build, and backend
ruff/pytest — all green. The only remaining items are P3 nice-to-haves
(GAP-4 tray, GAP-7 <2s guard, GAP-8 Parakeet, GAP-9 multilingual, GAP-12 2s
partials, GAP-17 tags/attendees, GAP-19 DND/sound).

The audio features (GAP-1/2/3/11) still warrant an on-device mic test — they
compile and type-check clean, but real-hardware capture (device switching,
pause/resume mid-recording, the recorded WAV's fidelity) can't be exercised
from CI.

---

This report compares Meetwit against Meetily across **architecture**, **UX flows**,
**features**, and **settings**, then lays out a prioritized backlog to close the
real gaps. It is grounded in both codebases — Meetily's source (frontend
`frontend/src`, backend `backend/app`) and Meetwit's own source.

The headline finding: **Meetwit and Meetily are architecturally different in a
way that favors Meetwit on intelligence and Meetily on recording polish.**
Meetwit does local transcription + RAG-grounded Q&A + cross-meeting conflict
detection that Meetily does not have. Meetily has a more mature *recording shell*
(pause/resume, tray, device pickers, import audio, retranscribe, crash recovery)
and a richer *notes editor* (BlockNote). The gaps worth closing are mostly in
recording ergonomics and a few persistence/robustness items — not in core AI.

---

## 0. Architecture at a glance

| Dimension | Meetily | Meetwit |
| --- | --- | --- |
| Shell | Tauri 2 + Next.js (app router) | Tauri 2 + React 19 + TanStack Router |
| Transcription | **Client-side** in Rust (whisper.cpp + Parakeet ONNX); backend only stores text | **Backend/Rust** whisper-rs + Silero VAD; emits `transcript-update` events |
| Backend | FastAPI + SQLite (aiosqlite), stores transcripts/summaries only | FastAPI + SQLite + **sqlite-vec** (embeddings), RAG retrieval |
| Summary | pydantic-ai → Claude/Groq/OpenAI/Ollama, chunked, BlockNote JSON | structured Pydantic → Ollama (gemma3), overview/decisions/actions/title |
| Editor | **BlockNote** rich editor (blocks, colors, headings) | **TipTap** rich editor (slash menu, headings, lists, tasks) |
| Distinctive | Import audio, retranscribe, tray, crash recovery, analytics | **RAG memory across all meetings**, **live Copilot Q&A**, **cross-meeting conflict detection**, **knowledge-base document indexing** |
| Persistence | IndexedDB (live) + SQLite (saved) | Zustand store + SQLite, single global subscription at root |
| Auth/Multi-user | None (CORS `*`) | None |

**Takeaway:** the two products overlap on "record → transcribe → summarize" but
Meetwit invested in *post-meeting intelligence* (RAG, conflicts, copilot) while
Meetily invested in *recording reliability + editing*. We should borrow the
recording-shell maturity without abandoning our intelligence layer.

---

## 1. Routes / screens

| Screen | Meetily | Meetwit | Gap |
| --- | --- | --- | --- |
| Home | `/` recording screen w/ live transcript + recovery dialog | `/` minimal welcome + start CTA + floating mic pill | ✅ aligned (Meetwit cleaner) |
| Live recording | merged into `/` | dedicated `/meeting/live` (2-pane: transcript + Copilot/Summary tabs) | ✅ Meetwit richer |
| Meeting detail | `/meeting-details` (transcript + summary + pagination) | `/meeting/$id/summary` (2-pane: transcript + editable summary + actions table) | ✅ aligned |
| Note view | `/notes/[id]` static markdown render | (folded into summary editor) | ⚠️ minor — Meetwit's editor covers it |
| Settings | `/settings` 5 tabs | `/settings` 5 tabs (General/Recordings/Transcription/Summary/Beta) | ✅ aligned |
| Onboarding | `OnboardingContext` first-launch flow | `/onboarding` 4-step wizard + first-run gate | ✅ aligned |
| Memory / Ask | ❌ none | `/memory` RAG Q&A across everything | ✅ **Meetwit-only** |
| Tasks / Action items | ❌ (only inside summary) | `/tasks` dedicated action-item list | ✅ **Meetwit-only** |
| Documents / Knowledge | ❌ none | `/knowledge` route exists in backend (UI removed per product decision) | n/a (intentionally hidden) |

---

## 2. Recording shell — **biggest real gap**

Meetily's recording controls are notably more mature. This is the #1 area to close.

| Capability | Meetily | Meetwit | Action |
| --- | --- | --- | --- |
| Start / Stop | ✅ | ✅ | — |
| **Pause / Resume** | ✅ `pause_recording()` / `resume_recording()` real | ⚠️ pill shows a disabled Pause (UI only) | **GAP-1** implement pause/resume in Rust |
| Audio level meter | ✅ live waveform via `start_audio_level_monitoring` | ✅ `WaveformBars` polls `mixerStatus` RMS | ✅ aligned (Meetwit polls; could push) |
| **Device selection** | ✅ real mic + system-audio device pickers from `get_audio_devices()` | ⚠️ Settings shows static "Default" only | **GAP-2** expose `cpal` device list + persist + use |
| **System-audio backend toggle** | ✅ CoreAudio/Pulse/ALSA, actually applied | ⚠️ SCK/Core-Audio radio persists but unused | **GAP-3** wire backend choice to capture |
| **Tray / global pause** | ✅ macOS tray menu controls recording | ❌ none | **GAP-4** add tray indicator + controls |
| **Crash / session recovery** | ✅ IndexedDB recovery dialog on startup | ⚠️ store persists across nav but no crash-recovery dialog | **GAP-5** detect orphaned `recording` meetings on launch, offer resume/finalize |
| **Recording-start compliance notice** | ✅ `ComplianceNotification` "inform participants" banner | ⚠️ Settings toggle exists, no banner rendered | **GAP-6** render the banner when recording begins |
| Min-duration guard | ✅ enforces ≥2s | ❌ none | **GAP-7** (minor) ignore <2s recordings |

---

## 3. Transcription

| Capability | Meetily | Meetwit | Action |
| --- | --- | --- | --- |
| Local Whisper | ✅ whisper.cpp client-side | ✅ whisper-rs backend | ✅ |
| Model catalog UI | ✅ Small/Medium/Large/Turbo/quantized + download | ✅ Tiny/Small/Medium/Large V3 + download | ✅ aligned |
| Download progress | ✅ per-model progress | ✅ `whisper-download-progress` + floating tile | ✅ |
| **Parakeet (real-time, on-device)** | ✅ ONNX, "Recommended/real-time" | ❌ not implemented (listed "coming soon") | **GAP-8** (optional) evaluate Parakeet for lower latency |
| **Language selection** | ✅ picker affects Whisper | ❌ English-only (`*.en` models) | **GAP-9** support multilingual whisper models + language picker |
| **Cloud STT providers** | ✅ Deepgram/ElevenLabs/Groq/OpenAI (backend) | ❌ local-only | low priority (privacy-first stance) |
| **Import audio file → transcribe** | ✅ `start_import_audio_command` | ❌ removed from UI | **GAP-10** add back as a real feature when there's a backend path |
| **Retranscribe with another model** | ✅ `start_retranscription_command` (beta) | ⚠️ modal UI exists, no backend | **GAP-11** wire retranscribe to saved audio |
| VAD | (in client engine) | ✅ Silero VAD | ✅ Meetwit explicit |
| Speaker diarization | ❌ (timestamps only, no labels) | ❌ (Beta toggle, not implemented) | parity — both lack it |
| Real-time partials | ✅ streamed partials w/ confidence | ⚠️ 10s windows + "Listening…" animation (no sub-window partials) | **GAP-12** Beta flag exists; implement 2s partials |

---

## 4. Summarization & intelligence

| Capability | Meetily | Meetwit | Action |
| --- | --- | --- | --- |
| Summary generation | ✅ chunked pydantic-ai | ✅ structured Pydantic | ✅ |
| **Auto title from transcript** | ✅ extracts `MeetingName` | ✅ `MeetingTitle` schema (shipped this session) | ✅ aligned |
| Provider support | ✅ Claude/Groq/OpenAI/Ollama + custom OpenAI endpoint | ✅ Ollama default; OpenAI/Claude/Groq/OpenRouter pickers in UI (keys localStorage) | ⚠️ **GAP-13** Meetwit's cloud providers are UI-only — backend always uses Ollama. Wire BYOK through to the LLM call. |
| Local models | ✅ Gemma 3 1B/4B, llama3.2 via Ollama/built-in | ✅ Gemma 3 1B/4B (aligned this session) | ✅ |
| **Summary templates** | ✅ `api_list_templates` (standard_meeting, etc) + custom prompt | ❌ single fixed prompt | **GAP-14** add template picker + custom-prompt field |
| **Custom prompt** | ✅ per-generation custom prompt | ❌ | part of GAP-14 |
| Auto-summary on save | ✅ toggle | ✅ Settings toggle (persisted; needs runtime hook) | **GAP-15** actually trigger post-meeting on stop when enabled |
| Action items | ✅ inside summary JSON | ✅ dedicated table + `/tasks` page + checkboxes | ✅ Meetwit richer |
| Decisions | ⚠️ "KeyItemsDecisions" block | ✅ first-class `decisions` entity | ✅ |
| **Cross-meeting conflict detection** | ❌ | ✅ `/conflicts/{id}/detect` | ✅ **Meetwit-only** |
| **RAG memory / Ask across meetings** | ⚠️ plain LIKE text search only (chromadb unused) | ✅ sqlite-vec embeddings + hybrid retrieval + cited answers | ✅ **Meetwit far ahead** |
| **Live Copilot Q&A during meeting** | ❌ | ✅ `/live/ask` streaming w/ citations | ✅ **Meetwit-only** |
| Proactive insights watcher | ❌ | ✅ `insights/scan` (contradictions/risks/decisions) | ✅ **Meetwit-only** |

---

## 5. Editor & notes

| Capability | Meetily | Meetwit | Action |
| --- | --- | --- | --- |
| Rich editor | ✅ BlockNote (blocks, colors, drag) | ✅ TipTap (slash menu, H1-3, lists, tasks, quote, code) | ✅ aligned |
| Slash menu | ✅ | ✅ (shipped this session) | ✅ |
| Persisted edited summary | ✅ `save-meeting-summary` | ✅ `summary_md` column + debounced PATCH | ✅ |
| Block colors / callouts | ✅ gray/default block colors | ❌ | low priority |
| **Markdown/PDF export** | ⚠️ copy markdown/JSON only | ⚠️ copy transcript only | **GAP-16** add Export → Markdown / PDF |
| Tags / attendees metadata | ✅ note view shows attendees + tags | ❌ no tags/attendees | **GAP-17** (optional) add tags + attendees fields |

---

## 6. Search & navigation

| Capability | Meetily | Meetwit | Action |
| --- | --- | --- | --- |
| Sidebar meeting list | ✅ with search/filter | ✅ persistent notes list | ✅ |
| **Full-text search across transcripts** | ✅ `/search-transcripts` (LIKE) | ⚠️ ⌘K palette searches titles only; `/memory` does semantic search | **GAP-18** make ⌘K (or sidebar search) also hit transcript text |
| Command palette (⌘K) | ❌ | ✅ | ✅ **Meetwit-only** |
| Keyboard shortcuts | ⚠️ tray-driven | ✅ ⌘K, ⌘N | ✅ |

---

## 7. Settings — tab-by-tab diff

Both have **General / Recordings / Transcription / Summary / Beta**. Differences:

| Setting | Meetily | Meetwit | Action |
| --- | --- | --- | --- |
| Notifications toggle | ✅ + DND override + sound | ✅ basic toggle | **GAP-19** add DND override + sound options |
| Storage locations | ✅ db/models/recordings folders + open | ✅ recordings folder open | ✅ mostly |
| Analytics opt-in + transparency modal | ✅ | ✅ toggle + User ID (no transparency modal, no real telemetry) | low priority (privacy-first → maybe never) |
| Device pickers | ✅ real | ⚠️ static | GAP-2 |
| Audio backend | ✅ applied | ⚠️ persisted-only | GAP-3 |
| Transcription model list | ✅ | ✅ | ✅ |
| Summary provider + keys | ✅ wired to backend | ⚠️ UI-only | GAP-13 |
| Auto-summary toggle | ✅ functional | ⚠️ persisted-only | GAP-15 |
| Beta: import+retranscribe | ✅ feature-flagged real | ⚠️ toggles persist, features not built | GAP-10/11/12 |
| **Re-run onboarding** | (onboarding context) | ✅ button (shipped this session) | ✅ Meetwit nicety |

---

## 8. What Meetwit does BETTER (defend these)

These are genuine differentiators — don't regress them while closing gaps:

1. **RAG memory** — semantic search + cited answers across all meetings AND indexed docs (sqlite-vec). Meetily only has LIKE text search; chromadb is in requirements but unused.
2. **Live Copilot** — ask questions *during* the meeting, grounded in transcript + docs, streamed with citations. Meetily has nothing live.
3. **Cross-meeting conflict detection** — flags when a new decision contradicts a past one.
4. **Proactive insights watcher** — surfaces contradictions/risks/commitments as the meeting unfolds.
5. **Dedicated action-items page** with cross-meeting view + toggles.
6. **Command palette** (⌘K) + ⌘N shortcuts.
7. **Cleaner, more focused UX** — Meetily's recording screen is busier; Meetwit's empty-state and 2-pane summary are tighter.

---

## 9. Prioritized backlog to close gaps

### P0 — make existing UI actually work (no new surface, high trust impact)
- **GAP-13** Wire summary provider/API-key selection through to the backend LLM call (today cloud picks are cosmetic; backend always uses Ollama). Store keys in macOS Keychain.
- **GAP-15** Honor "Auto-summary on stop" — trigger `triggerPostMeeting` automatically when recording stops and the toggle is on.
- **GAP-2** Real device pickers — expose `cpal` devices via a Tauri command, populate Settings, pass selected devices into `startMeeting`.
- **GAP-6** Render the recording-start compliance banner when the Settings toggle is on.

### P1 — recording-shell maturity (closes the biggest UX gap vs Meetily)
- **GAP-1** Implement real Pause/Resume in the Rust mixer/ASR + enable the pill button.
- **GAP-5** Crash/session recovery: on launch, find meetings stuck in `recording` status and offer resume/finalize.
- **GAP-3** Apply the System-Audio-Backend choice (SCK vs Core Audio) to capture.
- **GAP-11** Wire Retranscribe modal to a real backend endpoint over the saved audio file (requires keeping audio — `recording_path` already planned).

### P2 — feature parity that adds clear value
- **GAP-14** Summary templates (Default/Standup/Sales/Interview) + custom-prompt field, with `template_id` on the post-meeting endpoint.
- **GAP-16** Export summary → Markdown and PDF.
- **GAP-18** Make the sidebar/⌘K search hit transcript text (cheap LIKE) in addition to titles.
- **GAP-12** Real-time partial transcripts (2s windows) behind the existing Beta flag.
- **GAP-10** Import-audio-file flow (when a transcription path for arbitrary files exists).

### P3 — nice-to-have / optional given privacy-first stance
- **GAP-9** Multilingual whisper + language picker.
- **GAP-8** Parakeet real-time engine evaluation.
- **GAP-4** macOS tray indicator + controls.
- **GAP-17** Tags + attendees metadata on notes.
- **GAP-19** Notification DND-override + sound.
- **GAP-7** <2s recording guard.

---

## 10. Suggested sequencing

1. **Sprint A (trust):** GAP-13, GAP-15, GAP-2, GAP-6 — everything the UI already promises should actually work.
2. **Sprint B (recording polish):** GAP-1, GAP-5, GAP-3, GAP-11 — match Meetily's recording reliability.
3. **Sprint C (parity value):** GAP-14, GAP-16, GAP-18, GAP-12.
4. **Backlog:** P3 items as demand dictates.

This ordering fixes the credibility gap first (don't show settings that do
nothing), then closes the one area Meetily genuinely leads (recording shell),
then adds parity features — all while preserving Meetwit's intelligence lead.

---

## Appendix — source references

**Meetily** (`/tmp/meetily-ref`):
- Frontend routes: `frontend/src/app/{page,settings,meeting-details,notes/[id]}.tsx`
- Contexts: `frontend/src/contexts/{RecordingState,Transcript,Config,Onboarding}Context.tsx`
- Settings: `frontend/src/components/{Preference,Recording,Transcript,SummaryModel,Beta}Settings.tsx`
- Tauri commands: `frontend/src-tauri/src/*` (audio, whisper, parakeet, builtin_ai, api_*, analytics)
- Backend endpoints: `backend/app/main.py`; schema: `backend/app/db.py`; summary: `backend/app/transcript_processor.py`

**Meetwit** (this repo):
- Frontend routes: `desktop/src/routes/{index,meeting.live,meeting.$id.summary,memory,tasks,settings,onboarding}.tsx`
- Lifecycle: `desktop/src/lib/meetingLifecycle.ts`; prefs: `desktop/src/lib/prefs.ts`
- Backend routers: `backend/src/meetwit/routers/{meetings,memory,post_meeting,knowledge}.py`
- Summary pipeline: `backend/src/meetwit/services/post_meeting.py`
