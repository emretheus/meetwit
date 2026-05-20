# Meetwit V1 — Acceptance Test Plan

Run these tests before tagging `v1.0.0`. Each maps directly to one of the five V1 product promises. V1 ships only if every functional test passes on M2 Pro hardware (M1 failures are acceptable as documented "M2+ recommended"; M3 failures are blockers).

## Prereqs

- macOS 13+ on Apple Silicon
- Meetwit.app installed (signed + notarized .dmg)
- Ollama installed with `qwen2.5:7b-instruct` and `qwen2.5:3b-instruct` pulled
- A "real" company-document folder with ~10 PDFs, totaling ~200 pages

## Functional tests

### 1. Index local docs

**Pass criteria:**
- Drag-drop or type the folder path into `/knowledge` → "Index"
- Progress event fires, eventually `finished=true`
- `indexed_files === 10` (or your folder size)
- `failed_files === 0`
- `/knowledge/stats` shows chunk count > 0
- Total wall time ≤ 3 min on M2 Pro

**Search verification:**
- Pick one specific known phrase from one specific PDF
- Navigate to `/memory`, ask a question referencing it
- The top citation must point at the correct doc + page

### 2. Live transcript

**Pass criteria:**
- Start a meeting via `/meeting/live`
- Play a 30-min English-language YouTube video (or do a real Zoom call)
- Transcript fills the left pane in near real time
- Display lag from spoken word to text on screen ≤ 1.5s on M2 Pro
- Word-error rate ≤ 15% on clear speech (estimate manually by comparing to known content)
- Click "Stop meeting" — meeting status flips to `completed`

### 3. In-meeting Q&A with sources

**Pass criteria:**
- During the live meeting, ask three questions in the right pane:
  - One about something said in the last 2 minutes
  - One that should pull from indexed docs
  - One that requires both
- Each answer streams in within 6s on M2 Pro
- Each answer cites at least one source (transcript span or doc chunk)
- Sources panel is open by default

### 4. Conflict detection

**Pass criteria:**
- Pre-seed an indexed doc with explicit policy text (e.g. "Refunds are 30 days max")
- In a scripted meeting, deliberately say the opposite ("we'll honor 60-day refunds")
- After the meeting ends, click "Detect conflicts" on `/meeting/$id/summary`
- Within 15s, a conflict appears with confidence ≥ 0.8
- The description mentions both sides (meeting + doc)

### 5. Post-meeting summaries / decisions / action items

**Pass criteria:**
- After a 30-minute meeting ends, click "Process meeting"
- Within 90s on M2 Pro, the Summary tab shows:
  - Overview ≤ 200 words
  - At least 3 key points
  - At least 1 recommended next step
- The Decisions tab shows ≥ 3 distinct decisions
- The Actions tab shows ≥ 2 action items with owners and/or deadlines where stated
- ≥ 80% precision on decisions (manual judgment — review each one, flag false positives)

## Non-functional tests

### Privacy

**Pass:** during a meeting, run:
```bash
lsof -i -nP -p $(pgrep meetwit)
```
The only outbound connections shown should be `127.0.0.1:5167` (sidecar) and `127.0.0.1:11434` (Ollama). No others.

### Cold-start

**Pass:** from double-click on `Meetwit.app` (after a full shutdown) to interactive window ≤ 4s on M2 Pro.

Measure with:
```bash
time open -W -a Meetwit.app  # crude — counts wall time until app exits, but useful as upper bound on launch
```

### Gatekeeper

**Pass:** download `Meetwit_0.0.1_aarch64.dmg` over the network onto a fresh Mac, double-click. The app opens with no "this app is damaged" or "unverified developer" dialog. (Requires signing + notarization completed.)

## Hardware matrix

| Test | M1 Air 8GB | M2 Pro 16GB | M3 Max 36GB |
|---|---|---|---|
| Index 10 PDFs in <3min | acceptable if <5min | **required** | required |
| Live transcript <1.5s lag | acceptable up to 3s | **required** | required |
| Q&A latency <6s | acceptable up to 10s | **required** | required |
| Conflict detection <15s | acceptable up to 30s | **required** | required |
| Post-meeting pipeline <90s | acceptable up to 180s | **required** | required |
| Cold-start <4s | acceptable up to 6s | **required** | required |

## What V1 explicitly does NOT verify

- Performance with knowledge bases > 1000 documents (deferred to V1.1 — current BM25 is in-memory, FTS5 migration plotted)
- Multi-language meetings (V1 is English-only; pyannote.audio diarization in V1.1 will add speaker labels)
- Cloud-LLM mode (BYOK Claude/OpenAI) — wired into `ChatProvider` Protocol but no UI; V1.1 ships the toggle
- Auto-update (V1.1)
- Windows / Linux (post-V1)
- App Store distribution (post-V1, requires sandbox migration)

## Sign-off

| Tester | Hardware | Date | All-pass? |
|---|---|---|---|
| _________ | _________ | _________ | ☐ |
| _________ | _________ | _________ | ☐ |
| _________ | _________ | _________ | ☐ |

Three independent passes → tag `v1.0.0` → ship.
