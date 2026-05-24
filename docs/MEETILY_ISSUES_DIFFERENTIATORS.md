# Meetwit Differentiators — sourced from Meetily's issue tracker

> Status: DRAFT · 2026-05-24
> Source: `Zackriya-Solutions/meetily` GitHub **issues** (open + recently closed,
> sorted by engagement), audited against Meetwit's current code.
> Companion to [`MEETILY_GAP_ANALYSIS.md`](./MEETILY_GAP_ANALYSIS.md), which
> compares the two *codebases*. **This doc is different:** it reads what
> Meetily's *users are actively complaining about or asking for* and turns each
> into a Meetwit positioning or roadmap decision.

The point of this exercise: a competitor's issue tracker is free product
research. Every open bug is a promise they've broken; every loud feature request
is unmet demand we can serve. Below, each Meetily issue is mapped to one of three
buckets:

- 🟢 **WE WIN** — Meetwit already handles this, often as a deliberate stance.
  Lead with these in marketing.
- 🟡 **QUICK WIN** — real demand, small build for us, high credibility payoff.
- 🔴 **BIG GAP** — real demand, larger build, and an area where we're currently
  *behind*.

---

## TL;DR — the leverage map

| Meetily issue | Theme | Meetwit bucket | Move |
| --- | --- | --- | --- |
| **#448** privacy policy lies (PostHog ships meeting titles) | Trust | 🟢 **WE WIN** | Make "verifiably zero telemetry" the headline. Kill the dead analytics toggle. |
| **#449** auto-record from calendar | Trust/UX | 🟢 **WE WIN** | We sync calendars but *never auto-record* — that's the feature, say so. |
| **#413** summary output language (≠ spoken language) | Reach | 🟡 **QUICK WIN** | Decoupled from ASR — a one-line prompt change in `prompts.py`. |
| **#474** Whisper domain vocabulary | Accuracy | 🟡 **QUICK WIN** | We already inject an `initial_prompt`; just expose it in Settings. |
| **#441** export transcript (txt/vtt) | Portability | 🟡 **QUICK WIN** | We export MD/HTML; add VTT/SRT/JSON/TXT. |
| **#389** notes during recording | Workflow | 🟡 **QUICK WIN** | Absent; natural fit for the live 2-pane view. |
| **#336/#425** prerecorded / batch audio import | Workflow | 🟡 **QUICK WIN** | `retranscribe_file` already exists internally — expose "Import audio". |
| **#393** merge / resume interrupted meetings | Workflow | 🔴 **BIG GAP** | Interruptions create orphan records; no merge. |
| **#424** folder organization | Scale | 🔴 **BIG GAP** | We have flat `project` tags, no hierarchy. |
| **#233 / #427** multilingual *transcription* (non-`.en`) | Reach | 🔴 **BIG GAP** | English-only ASR. Most-discussed issue; #427 = Arabic broken. |
| **#414** screen recording | Feature | ⚖️ **STANCE** | Most sensitive artifact possible — opt-in only, or do screenshots/slide-indexing instead. |
| **#431** OpenAI-compatible custom headers | BYOK | 🟢/🟡 | Our BYOK is local-key + opt-in; check we pass through custom headers/endpoints. |
| **#450** Bluetooth mic capture fails | Reliability | 🟢/🟡 | We have real device selection via cpal; verify BT on-device. |
| **#456/#306/#465** GPU / CPU-arch transcription failures | Reliability | 🟢 **WE WIN** | Metal GPU path is live; document it. |
| **#433/#428/#426/#435/#437/#415/#429/#454** platform sprawl | Reliability | 🟢 **WE WIN** | ~35% of their recent bugs are Win/Linux/old-x86 — impossible for our Mac-only target. |
| **#411** dark mode | Polish | (n/a) | Check our theme story. |

---

## 🟢 Where Meetwit already wins — lead with these

### 1. Verifiable privacy is the headline (Meetily #448)

**Their problem:** Meetily's privacy policy explicitly lists *"❌ meeting titles
are not collected,"* but their `track_meeting_started` analytics function sends
the meeting title to **PostHog on every meeting start**, on all platforms. For a
tool that markets itself as privacy-first, the stated policy and the shipped code
contradict each other.

**Meetwit's reality (audited in code):** zero outbound analytics. Every HTTP call
goes to `localhost` (the auto-spawned sidecar + Ollama at `:11434`) or to a
user-configured, opt-in LLM API with a BYOK key. No PostHog, Sentry, Mixpanel, or
Segment anywhere in the Rust or Python. The README's "nothing leaves" claim is
**true and checkable** — `grep` the repo and the absence is the proof.

**The move:** make "privacy you can verify, not just promise" the top-line
differentiator. We can invite exactly the audit that embarrassed Meetily.

> ⚠️ **One loose thread to fix first.** There is an `analytics` boolean in
> `desktop/src/lib/prefs.ts` with a toggle in `settings.tsx` that is **wired to
> nothing** — no code reads it. A dead "analytics" switch in a privacy product
> invites the same suspicion that sank Meetily. **Either delete it or give it a
> real, honest meaning** before we lean on this differentiator. (Tracked
> loosely as the analytics line in `MEETILY_GAP_ANALYSIS.md` §7.)

### 2. We sync calendars but never auto-record (Meetily #449)

**Their request:** users want Meetily to auto-start/stop recording based on
Google Calendar events — "it's a hassle to manually start and stop."

**Meetwit's stance:** we already do calendar sync (OAuth in Rust, tokens in the
macOS Keychain, never in the Python sidecar; `calendar_util.py` even parses
Zoom/Meet/Teams links and auto-names meetings). But we deliberately **only
remind, never auto-record** — Settings says verbatim: *"We never auto-record —
you always click Record."*

This is not a missing feature; it's a privacy posture. Auto-recording is how you
end up silently capturing a 1:1 you shouldn't have. **Frame the manual click as a
consent guarantee, not a friction point.** (If demand is loud, the safe middle
ground is a one-tap "Record this meeting?" notification when an event starts —
consent preserved, hassle reduced.)

### 3. Transcription that doesn't fall over on the hardware (Meetily #456 / #306 / #465)

**Their problems, recurring:** local Whisper not using the GPU (#456); the
Whisper backend failing or crawling on CPUs without AVX2/FMA (#306, #465 — a
*silent* crash on pre-Haswell chips). These are reliability complaints that keep
recurring across versions.

**Meetwit's reality:** we target Apple Silicon only and run whisper-rs on the
**Metal GPU** path today (CoreML/ANE is the planned upgrade for a ~2× speedup; we
fall back to Metal cleanly with a one-line log warning, not a silent crash). A
narrow, well-specified hardware target (M1+) is *why* our transcription is
reliable where their broad target isn't.

**The move:** turn the "macOS Apple Silicon only" constraint into a quality
promise — "tuned for your Mac's GPU, real-time, no config" — rather than
apologizing for it.

### 3a. Cross-platform sprawl is most of their bug volume — and we don't have it

A large fraction of Meetily's last-two-months issues are **not product bugs, they
are platform-portability bugs**: Linux blank window / WebKitGTK (#435), Linux
ALSA device names (#437), Linux PipeWire stealing other apps' audio (#433), Arch
build failure (#428), `cidre` not macOS-gated breaking Linux (#426), Windows
Whisper latency (#415), Windows model-load failures (#429), pre-Haswell CPU crash
(#465), Tauri-2.11 compile breakage (#454). That's ~9 of ~26 recent issues
(≈35%) burned on Windows/Linux/old-x86 support.

Meetwit's single-target stance (**macOS 13+, Apple Silicon, bundled models, no
build-it-yourself path for users**) makes this entire category *structurally
impossible for us to hit.* This is not a feature — it's an entire class of
support cost and user frustration we've designed away. Worth stating plainly when
explaining why "Mac-only" is a choice, not a limitation.

---

## 🟡 Quick wins — real demand, small build, high payoff

### 4. Summary output language, decoupled from spoken language (Meetily #413)

**Their request — and the key insight everyone misses:** the requester wants to
set the **summary output language independently of the meeting language**. A team
that *speaks* English may need the written summary in German for their docs; a
team speaking German may want an English summary for a global stakeholder. The
requester explicitly notes this is *"likely a one-line prompt change — low
engineering effort"*: inject `Generate the summary in [language]` into the
summarization prompt. Persist a Settings default, allow a per-meeting override.

**Why this is separate from #233 (and why it matters for us):** summary language
has **nothing to do with the transcription model.** We can keep our English-only
Whisper and *still* ship this — the LLM (Ollama/Gemma, or any BYOK provider)
already speaks dozens of languages. So a large slice of "multi-language" demand is
serviceable **today, behind a prompt change**, without touching ASR.

**Meetwit's reality:** absent — `backend/src/meetwit/llm/prompts.py` is
English-only with no language parameter.

**The build:** add a `summary_language` preference + per-meeting override, thread
it into the post-meeting prompt. This is the **single cleanest effort-to-impact
item in the entire list** — smaller than the domain-vocabulary win and it
directly chips away at their loudest theme (multi-language) without the V2-scale
ASR work. *Do this first among the quick wins.*

### 5. User-editable Whisper domain vocabulary (Meetily #474)

**Their request (well-argued):** expose Whisper's `initial_prompt` so users can
bias the decoder toward proper nouns, client names, product names, and jargon —
e.g. "Devinco" heard as "de Vinco", "user stories" as "Juicy Stories". The
acoustic confusion is systematic and repeatable, so a vocabulary hint fixes it
permanently.

**Meetwit's reality:** we *already* inject a `DEFAULT_INITIAL_PROMPT` of product
terms in `desktop/src-tauri/src/asr/engine.rs`, and `DecodeOptions::extra_prompt`
exists — it's just an **internal API with no UI**. We also already feed the prior
segment as continuity context for proper-noun spelling.

**The build:** a Settings field (or per-meeting "Topics/Names" box) that flows
into `extra_prompt`. The plumbing is done; this is mostly UI + a preference. This
is the **highest payoff-per-effort item in the whole list** and it lands directly
on accuracy — the thing meeting-tool users judge first.

### 6. Transcript export in portable formats (Meetily #441)

**Their request:** export the raw transcript as `.txt` (no timestamps) and `.vtt`
(with timestamps), for portability in privacy-sensitive workplaces.

**Meetwit's reality:** `desktop/src/lib/export.ts` already exports a full meeting
as **Markdown** and **HTML** (for ⌘P → Save as PDF). Missing: plain `.txt`,
`.vtt`, `.srt`, and `.json`.

**The build:** add formatters next to `buildMarkdown()`. VTT/SRT need segment
timestamps, which we already have in the transcript chunks. Small, and it
reinforces the "your data, fully portable" story that privacy users want.

### 7. Take notes during recording (Meetily #389)

**Their request:** jot manual notes *while* recording, not just edit the summary
afterward.

**Meetwit's reality:** absent. We only allow editing the AI summary post-hoc
(TipTap on the summary page). The live view (`LiveMeetingView.tsx`) shows
transcript + Copilot Q&A but has no note field.

**The build:** a notes pane/field in the live 2-pane layout, persisted on the
meeting, merged into the export and the summary context. Natural fit, and it
makes the live screen a genuine workspace rather than a passive transcript.

### 8. Import a prerecorded audio file (Meetily #336 closed, #425 batch)

**Their demand:** transcribe an existing audio file, and batch-process several.

**Meetwit's reality:** no "Import audio" button — but a Tauri command
`retranscribe_file(audioPath, model)` **already runs Whisper over an arbitrary
WAV in 30s chunks** (used internally to re-transcribe saved meeting audio with a
different model). The transcription path for arbitrary files already exists.

**The build:** a file picker that creates a meeting record and points
`retranscribe_file` at the chosen file. Mostly wiring of components we already
have. (This is `GAP-10` in the gap analysis, now de-risked because the engine
path exists.)

---

## ⚖️ Stance calls — requested, but decide deliberately

### Screen recording (Meetily #414, 4 comments)

**Their request:** capture the *screen* during a meeting (demos, dashboards,
slides) and attach the video to the session, so users can review what was *shown*,
not just what was *said*.

**Why it's a stance call, not a quick win:** a screen recording is the single most
sensitive artifact a meeting tool can hold — far more than a transcript. It cuts
against the "minimal capture" instinct that underpins our privacy positioning, and
it's heavy (video storage, encoding). We already have ScreenCaptureKit wired for
*system audio*, so the technical door is ajar — which is exactly why the decision
should be explicit rather than incidental.

**Recommended posture:** treat as opt-in, off by default, clearly indicated while
active, stored only locally (consistent with everything else). A lighter-weight
alternative that serves much of the same need without the video liability:
periodic **screenshot capture** of the shared window, or pulling shared
**slides/docs** into the knowledge index so they're searchable alongside the
transcript — which plays to our RAG strength. Don't build the full screen
recorder reflexively just because they asked.

---

## 🔴 Big gaps — real demand, and we're behind

### 9. Multilingual *transcription* — non-English Whisper (Meetily #233)

**Their #1 most-discussed issue (11 comments).** Users want the **transcript**
(and downstream everything) in the meeting's actual spoken language, not forced
English. Note: the *summary*-language half of "multi-language" is broken out as
the §4 quick win (#413) and is shippable today. **This entry is specifically the
hard half — transcribing non-English speech**, which the summary-prompt trick
cannot fake.

**Concrete evidence it bites them:** #427 — *"Arabic is not reading well in all
models"* — is exactly this failure mode in the wild. The summary-prompt trick
(§4) cannot save a garbled Arabic transcript; only multilingual ASR can.

**Meetwit's reality:** **English-only ASR.** Whisper is hardcoded to `"en"`
(`engine.rs`), all four bundled models are `.en` variants (`model.rs` literally
notes *"V1 is English-only; multilingual models arrive in V2"*). Multilingual
transcription also implies a multilingual **embedding** model (BGE-M3) so RAG and
conflict detection keep working in-language.

**Why it matters competitively:** this is the largest single feature deficit and
the root of their loudest request — a whole segment of non-English users we could
win, but only once we ship multilingual Whisper + embeddings. Already on our V2
roadmap. **Sequencing:** ship §4 (summary language) first to claim "multi-language
support" for a real chunk of demand cheaply, *then* invest in multilingual ASR
here to complete the story.

### 10. Folder / hierarchy for organizing meetings (Meetily #424)

**Their request:** as the meeting list grows, a flat list becomes unmanageable;
they want create/rename/delete folders, drag-and-drop, and a collapsible sidebar
tree grouped by project/client/topic.

**Meetwit's reality:** **partial.** We have a flat, free-text `project` field on
the Meeting model (a tag/badge), but no hierarchy, no folder CRUD, and the list
is chronological.

**The build:** either promote `project` into a first-class filter/group-by in the
sidebar (cheaper, ~80% of the value) or add real nested folders (more work).
Given our intelligence angle, *smart* grouping (auto-cluster by topic via the
embeddings we already compute) could leapfrog their manual-folder request.

### 11. Merge / resume interrupted meetings (Meetily #393)

**Their request:** when a meeting is interrupted and resumed, Meetily creates two
separate records; users want to merge consecutive meetings (transcripts, audio,
summaries, metadata) with undo. Their workaround is FFmpeg + manual editing.

**Meetwit's reality:** **absent.** Each meeting is atomic; the meetings router is
CRUD-only with no merge, and there's no parent/child relationship in `models.py`.
We *do* have crash/session recovery (`GAP-5`, done) that finalizes orphaned
`recording` meetings — but not a user-driven merge.

**The build:** a merge endpoint that concatenates transcript chunks (re-basing
timestamps), unions decisions/action-items, and re-runs the summary over the
combined transcript. Non-trivial but bounded, and it removes a genuine
data-integrity papercut.

---

## Reliability items to verify (not yet differentiators)

- **Bluetooth mic capture (Meetily #450):** their app silently fails to capture
  AirPods/Bose mic input while system audio works. We have real device selection
  via cpal (`mic.rs` — `list_input_devices` + `start_with_device`), but **no
  Bluetooth-specific handling and no on-device BT test on record**. cpal *should*
  surface BT mics transparently, but macOS BT input (HFP vs A2DP profile
  switching) is exactly where these bugs live. **Action: test recording with
  AirPods before claiming this as a win.**
- **Dark mode (Meetily #411):** confirm Meetwit's theme handling end-to-end
  before treating polish as a differentiator.

---

## Recommended sequencing

1. **Trust pass (days):** kill/repurpose the dead analytics toggle (§1), then
   publish the "verifiable zero-telemetry" positioning. This is the cheapest,
   highest-leverage move — it's a differentiator we already *have* and Meetily
   structurally *can't* match without re-architecting their analytics.
2. **Reach + accuracy quick wins (1 sprint):** ship summary-output-language
   (§4 / #413 — the cheapest "multi-language" win), expose Whisper domain
   vocabulary (§5), add VTT/SRT/TXT/JSON export (§6), import-audio (§8).
3. **Workflow (1 sprint):** notes-during-recording (§7), then merge/resume (§11).
4. **Reach (V2 track):** multilingual *transcription* + embeddings (§9) to
   complete the multi-language story, and folder/auto-grouping (§10).

The throughline: we don't chase Meetily's feature list. We **double down on the
two things they can't credibly do — verifiable privacy and on-device
intelligence — and pick off the specific quick wins where their users are loudest
and our plumbing already exists.**

---

## Appendix — full coverage of the last 2 months (authoritative)

Pulled from the GitHub **API** (`repos/Zackriya-Solutions/meetily/issues`,
`since=2026-03-24`, PRs stripped) so nothing is missed — **26 issues created
in the window: 25 open, 1 closed.** Every one is accounted for below.

**Addressed as a differentiator/stance above:** #474 (vocab §5), #465 (platform
§3a), #461 (—, UI bug), #458 (—, doc typo), #456 (GPU §3), #454 (platform §3a),
#450 (BT §reliability), #449 (auto-record §2), #448 (**privacy §1**), #441
(export §6), #437 (platform §3a), #435 (platform §3a), #433 (platform §3a),
#431 (BYOK §reliability + map), #429 (platform §3a), #428 (platform §3a), #427
(**multilingual §9**), #426 (platform §3a), #425 (import §8), #424 (folders §10),
#422 (templates — ✅ we already have, see gap-analysis GAP-14), #421 (—, tray
icon polish), #415 (platform §3a), #414 (**screen recording §stance**), #413
(**summary language §4**), #412 (off-device transcription — counter to our
local-only stance, intentionally N/A).

**Deliberately *not* turned into a Meetwit action** (and why): #461 / #421 are
minor Meetily-internal UI bugs with no analogue here; #412 (off-device/cloud
transcription) runs *against* our privacy-first local-only design; #422 is
already shipped on our side. The large platform-bug cluster is rolled up into
§3a rather than itemized as separate actions, since the answer to all of them is
the same: we don't target those platforms.

**Older but high-signal issues also referenced** (outside the 2-month window,
surfaced via most-commented / recurring-theme sorts): #393 (merge meetings),
#389 (live notes), #336 (import audio, closed), #306 (AVX2 crash), #233
(multilingual, 11 comments — their most-discussed). These predate 2026-03-24 but
remain open/relevant, so they're folded in where they fit the themes above.

Meetwit code-state audit for each item is inline in the sections above; file
references point at this repo's `desktop/` and `backend/` trees.
