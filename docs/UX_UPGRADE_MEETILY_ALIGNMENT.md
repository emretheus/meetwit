# Meetwit ↔ Meetily UX Upgrade Plan

> Status: PROPOSED · 2026-05-21
> Owner: Emre
> Source of truth for visual references: `/docs/meetily/Screenshot 2026-05-21 at 00.*.png` (26 frames)

This document is a deep, end-to-end redesign plan that aligns Meetwit with the
framing of [Meetily](https://meetily.zackriya.com/) while preserving Meetwit's
unique advantages (RAG over your docs, live copilot Q&A, conflict detection,
knowledge base, memory chat). The result should read as a polished, focused
SaaS desktop app — not a research prototype.

The plan is **functionality-additive and visually rewriting**. We are not
ripping out backend behavior; we are reorganizing the surface, adding the few
genuinely-missing affordances that Meetily got right, and aligning the visual
language with what users will compare us to.

---

## 0. Why this overhaul exists

Side-by-side with Meetily, four things stand out in our screens today:

| Theme | Meetily | Meetwit (today) |
| --- | --- | --- |
| Recording shell | Floating pill control (mic + waveform + stop) anchored at viewport bottom. Always visible. | Stop button buried in top bar; no floating control. |
| Meeting list | Left rail = persistent meeting list with search. One click between meetings. | Recent meetings only on Home; no global sidebar list. |
| Post-meeting view | Tri-pane: timestamped transcript | tabs (Generate Summary / AI Model / Template) | structured summary with Key Decisions, Action Items table (Owner / Task / Due / Reference / Timestamp). Plus Copy / Recording / Enhance toolbar. | Single column tabs (Overview / Decisions / Actions / Conflicts / Transcript). No table. No transcript-on-left/summary-on-right pairing. |
| Onboarding | 4-step illustrated wizard with model downloads (Transcription Engine + Summary Engine cards with progress bars and a docked floating download tile in the corner). Permissions step has per-card Enable buttons. | Linear 6-step text wizard, no per-model download cards, no docked download status, no per-permission card pattern. |

Plus the small but compounding details: an **editor toolbar** above the
summary text with slash-menu / heading hierarchy / lists / tables; a **Beta**
settings tab and a **Recordings/Transcription/Summary** sub-tab layout in
Settings; an **Edit Meeting Title** modal with a real input + Save/Cancel
buttons; a **Retranscribe Meeting** modal with language + model dropdowns; a
**recording-saved toast** with "View Meeting" CTA; a **model picker modal**
with per-model RAM/quality blurbs and a Download button when not present.

Meetily also adopts a few framing choices that make the product feel less
"techy" and more like a tool:

- The product noun is **"meeting notes"**, not "meetings". The transcript is
  one artifact inside a *note*; the summary is another.
- The CTA is **"Start Recording"**, not "Start meeting". Idle → "Start
  Recording". Live → "Recording in progress…" (disabled style) + floating
  pause/stop/wave control at the bottom.
- The product wordmark sits in a **rounded pill** at the very top of the
  sidebar, with the **Search meeting content…** input directly below it.

These are not cosmetic preferences — they remove ambiguity. We adopt all of
them, except where Meetwit has a genuine reason to diverge (we keep the *brand
indigo* over Meetily's near-black flat black; we keep *Knowledge / Memory /
Tasks* as first-class features Meetily does not have).

---

## 1. Lock the design language

We already shipped an indigo-brand refresh (see `docs/UX_OVERHAUL.md`). This
plan extends that, it does **not** replace it.

### 1.1 Final palette (slight tweaks vs. current `styles.css`)

```css
@theme {
  /* App surfaces — match Meetily's near-white workspace, off-white sidebar */
  --color-bg:              #ffffff;
  --color-surface:         #fafafa;   /* main content area background */
  --color-surface-elevated:#ffffff;   /* cards/panels on top of surface */
  --color-surface-overlay: #ffffff;   /* modals / popovers */

  /* Sidebar — softened from #0a0a0a to a near-white, Meetily-style */
  --color-sidebar-bg:      #f7f7f8;
  --color-sidebar-elevated:#ffffff;   /* pill, active item */
  --color-sidebar-border:  #e7e7e9;
  --color-sidebar-text:    #18181b;
  --color-sidebar-text-mid:#52525b;
  --color-sidebar-hover:   #efeff1;

  /* Brand — stay indigo (Meetily uses near-black; we keep brand identity) */
  --color-brand-50:        #eef2ff;
  --color-brand-100:       #e0e7ff;
  --color-brand-500:       #6366f1;
  --color-brand-600:       #4f46e5;
  --color-brand-700:       #4338ca;
  --color-brand-800:       #3730a3;

  /* Recording — Meetily uses #ef4444 with soft tint */
  --color-recording:       #ef4444;
  --color-recording-soft:  #fee2e2;

  /* Borders */
  --color-border:          #e4e4e7;
  --color-border-strong:   #d4d4d8;
}
```

**Why move the sidebar from black → near-white?** Meetily's biggest visual
signature is the *light-on-light contrast* with subtle borders. The black
sidebar we shipped reads as "dev tool". A near-white sidebar reads as "notes
app". This is the single change with the most impact.

### 1.2 Typography

- Display + body: **Inter** (already set). Add `font-feature-settings: "cv11", "ss01"` for the slightly humanist Inter we see in Meetily.
- Numerals: `tabular-nums` everywhere we show durations, counts, progress.
- Reduce default body size to **13px** for desktop density (Meetily is 13–14).

### 1.3 Shape language

- Cards: `rounded-xl` (12px) — matches Meetily.
- Buttons: `rounded-lg` (8px) for primary, `rounded-md` (6px) for icon-only.
- Modal dialogs: `rounded-2xl` (16px), 1px hairline border + soft shadow.
- Input fields & dropdowns: `rounded-lg`, 1px border (`--color-border`), focus
  ring 2px brand-100. **No** thick focus rings — Meetily uses 1–2px subtle.

### 1.4 Iconography

Continue using Lucide. Meetily uses lucide-react verbatim. Where Meetily uses
a unique icon (the "logo glyph" beside the wordmark), we keep our gradient
Mic chip — it's our brand mark and is the right level of distinctive.

---

## 2. Re-frame the product

This is a wording / IA change that propagates through every screen.

### 2.1 Nouns

| Old (Meetwit) | New (Meetily-aligned) | Why |
| --- | --- | --- |
| Meeting | **Note** (in URLs: `/notes/$id`) | A "note" is the container; the transcript and summary are *inside* it. Matches user mental model. |
| Live meeting | **Recording** (route stays `/meeting/live` internally) | What's happening *right now* is a recording, not a meeting. |
| Start meeting | **Start Recording** | Verb-noun match, Meetily uses this. |
| Memory | **Ask my notes** (still keep `/memory` route) | "Memory" is too abstract — most users won't know what it does until they read help text. |
| Knowledge | **Documents** (still keep `/knowledge` route) | Plain noun. Lower the lift to understand. |
| Tasks | **Action items** | Already mostly there. Just relabel the page header. |

We keep the URL slugs (`/meeting/live`, `/knowledge`, `/memory`, `/tasks`,
`/settings`, `/onboarding`) so links and tests keep working. Only the **user-
facing labels** change.

### 2.2 The Recording floating control

This is the headline new element. From any screen where a recording is
active, a **floating pill** lives at the bottom of the workspace:

```
                           ┌────────────────────────────────┐
                           │  ⏸    ⏺ (red, large)    ▌▌▌    │
                           │ pause   stop       waveform   │
                           └────────────────────────────────┘
                                  ↑ floats above content
```

- Width: `auto`, centered horizontally on the workspace (NOT the full
  viewport — respects the sidebar offset).
- Bottom: `24px` from viewport bottom.
- Background: white, `shadow-lg`, `ring-1 ring-black/5`, `rounded-full`.
- Three controls inside:
  1. **Pause** — icon-only button, light. Maps to a future "pause" verb. For
     v1 it can simply be a soft "soft stop" that closes the current ASR
     window and freezes the elapsed timer, allowing instant resume. If we
     don't implement pause for v1, render the control as **disabled** with a
     tooltip "Pause coming soon" — *Meetily ships it as a UI affordance even
     if it's degenerate*; the social-proof is the floating pill itself.
  2. **Stop** — large red circular button (44×44), `Square` (filled) icon.
     Always enabled.
  3. **Waveform** — three vertical bars that animate based on current RMS
     amplitude. Reuse `useMeetingStore.getState().lastRms` — we already have
     it. Three bars, each tracking RMS in a 100ms decay-smoothed window.
- The pill is **NOT** shown on `/meeting/live` (the live screen has its own
  controls in its top bar). It IS shown on every other route while running.
- Click the waveform area (the body of the pill, not the buttons) →
  navigates to `/meeting/live`.

### 2.3 Persistent meeting list in the sidebar

Today the sidebar has Home / Live / Knowledge / Memory / Tasks / Settings,
plus the Start CTA. Meetily's sidebar has:

```
┌─ Meetily (pill) ────────┐
├─ Search meeting content │
├─ Home                   │
├─ Meeting Notes          │
│    Meeting 2026-05-21   │   ← persistent list
│    Lily app design      │
│    …                    │
└─────────────────────────┘
```

We adopt this structure:

```
┌─ Meetwit (gradient mic) ────────┐
├─ ⌕ Search notes & docs          │
│                                 │
├─ Primary                         │
│   ⌂ Home                         │
│   ◉ Recording (live)             │
│                                 │
├─ Notes                           │
│   • Q4 planning  · 2d ago        │
│   • Sales sync   · 4d ago        │
│   • Lily app spec· 6d ago        │
│   + (see all 18)                 │
│                                 │
├─ Workspace                       │
│   📁 Documents                   │
│   ✦ Ask my notes                 │
│   ☐ Action items                 │
│                                 │
├─ System                          │
│   ⚙ Settings                     │
│                                 │
├─ ▶ Start Recording (primary)    │
├─ ● Recording 02:14 (when live)  │
└─ v0.1.0    local                 │
```

The **search input** at the top of the sidebar is global — it searches
across note titles, transcripts, and document content. For v1 the simplest
implementation is a client-side fuzzy match against meeting titles + the
already-loaded transcripts; the embedding-backed memory search remains in
its own `/memory` screen. (A v1.1 plan to merge them is in §11 below.)

The **persistent notes list** shows the 6 most recent notes. Clicking a row
opens `/meeting/$id/summary`. A "see all" link below it expands to a full
modal list (or simply scrolls a side panel — TBD in §3.4).

---

## 3. Per-screen redesigns

Below: every screen, with a concrete diff between today and the target,
referenced to the Meetily screenshot that inspired the move.

### 3.1 Onboarding — `/onboarding`

**References**: screenshots `00.09.34` (Welcome), `00.09.45` (Setup
Overview), `00.09.55` & `00.10.07` (Getting things ready w/ corner download
tile), `00.12.59` (downloads complete + Continue), `00.13.08` (Grant
Permissions per-card with Enable buttons).

Today our onboarding is a 6-step text wizard. We rebuild it as a 4-step
illustrated wizard:

**Step 1 — Welcome**

```
                    Welcome to Meetwit
       Record. Transcribe. Summarize. All on your device.

        ┌────────────────────────────────────┐
        │ 🔒  Your data never leaves your    │
        │       device                       │
        │ ✦  Intelligent summaries &         │
        │       insights                     │
        │ ⚙  Works offline, no cloud         │
        │       required                     │
        └────────────────────────────────────┘

               [   Get Started   ]
             Takes less than 3 minutes
```

- Centered. Max-width 480px.
- Three feature bullets inside a single white card with a subtle hairline.
- CTA is the brand-indigo filled button.
- Subtle eyebrow line ("Takes less than 3 minutes") below.

**Step 2 — Setup overview**

```
               ✓ ─── ◐ ─── ○ ─── ○        (4-step progress dots)
                       (current)

                  Setup Overview
   Meetwit requires that you download the Transcription &
       Summarization AI models for the software to work.

       ┌──────────────────────────────────────────────┐
       │ Step 1 : Download Transcription Engine       │
       │ Step 2 : Download Summarization Engine    ⓘ  │
       └──────────────────────────────────────────────┘

                  [   Let's Go   ]
                 Report issues on GitHub
```

- Top: 4-dot progress, green ✓ for completed.
- Card with two textual steps. The `ⓘ` tooltip on Step 2 explains: "Local
  qwen2.5:3b-instruct (~2GB) — runs on Apple Silicon."

**Step 3 — Getting things ready**

```
               ✓ ─── ✓ ─── ◐ ─── ○            ┌─────────────────────────────┐
                                                │ ⬇ Summary Model (qwen 3b)   │
                  Getting things ready          │   8.8 / 1019.8 MB · 0%      │
   You can start using Meetwit after downloading │   [progress bar]            │
       the Transcription Engine.                 └─────────────────────────────┘
                                                       ↑ floating in corner

       ┌──────────────────────────────────────────────┐
       │ 🎤 Transcription Engine        ↺            │
       │     ~670 MB                                  │
       │     ██████░░░░░░░░░░░░░░░░░░    12%          │
       │     78.9 MB / 639.4 MB           4.1 MB/s    │
       └──────────────────────────────────────────────┘

       ┌──────────────────────────────────────────────┐
       │ ✦ Summary Engine               ↺            │
       │     ~806 MB                                  │
       │     ░░░░░░░░░░░░░░░░░░░░░░░░    0%           │
       │     8.8 MB / 1019.8 MB           2.7 MB/s    │
       └──────────────────────────────────────────────┘

                 [   ↺ (downloading…)   ]   (disabled)
```

When both finish, both cards swap their spinner for a green ✓ check icon and
the Continue button activates with text "Continue".

**Floating download tile** (top-right corner): same exact card style,
smaller. Tracks whichever model is currently downloading. Disappears when
both downloads complete or are at 0% (idle).

This is the screen Meetily executes best — it makes the wait feel useful.
For Meetwit we already have `whisper_download` events. We extend it to also
download the chosen LLM (qwen2.5:3b-instruct via `ollama pull`) and emit
unified progress on `model-download-progress` (a new Tauri event we add).

**Step 4 — Grant Permissions**

```
               ✓ ─── ✓ ─── ✓ ─── ◐

                    Grant Permissions
       Meetwit needs access to your microphone and system audio
                       to record meetings

       ┌──────────────────────────────────────────────┐
       │ 🎤 Microphone                                 │
       │     Required to capture your voice  [Enable] │
       │     during meetings                          │
       └──────────────────────────────────────────────┘

       ┌──────────────────────────────────────────────┐
       │ 🔊 System Audio                              │
       │     Click Enable to grant Audio    [Enable]  │
       │     Capture permission                       │
       └──────────────────────────────────────────────┘

                  [   Finish Setup   ]   (disabled until both enabled)
                       I'll do this later

    Recording won't work without permissions. You can grant them later in settings.
```

Per-card Enable buttons. After granting, the button becomes a green ✓
"Granted" badge. The Finish Setup button activates only when both are
granted (or you opt out via "I'll do this later" which routes to `/` and
sets a flag to nag in Settings).

**Behavior changes**:
- The current "Screen Recording" step is folded into "System Audio" (it's
  technically the same OS permission on macOS).
- The current "Ollama install" step is replaced by Step 3's Summary Engine
  download — we pull qwen2.5:3b-instruct ourselves via the `ollama` CLI we
  shell out to. If Ollama isn't installed at all, Step 3's Summary card
  shows an "Install Ollama" sub-CTA opening ollama.com.

### 3.2 Home — `/`

**References**: implicit (Meetily uses "Home" + meeting list pattern; the
hero gets reduced because the sidebar already shows notes).

Today our Home has: Eyebrow → Hero CTA → 4 StatCards → Recent meetings → 2
QuickLinks. That's too much for a tool whose sidebar already lists notes.

Rebuild Home as a **focused "ready state"**:

```
┌─────────────────────────────────────────────────────────────┐
│  HOME                                                       │
│                                                             │
│  Welcome back, Emre                                         │
│  18 notes · 4 open action items · indexed 2 days ago        │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ⏺  Start a new recording                            │   │
│  │     Mic + system audio · transcribes locally          │   │
│  │                                       [Start Recording]│   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Recent notes                              View all →       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Q4 planning sync          ● completed · 2d ago · 47 │ →│
│  │ Lily app design review    ● completed · 4d ago · 23 │ →│
│  │ Sales pipeline            ● completed · 6d ago · 19 │ →│
│  │ Onboarding redesign       ● completed · 7d ago · 31 │ →│
│  │                                                      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  Open action items                          See all →       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ☐ Draft launch checklist     Emre · due May 25      │   │
│  │ ☐ Send revised pricing       Sara · due May 23      │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ──── Tips ─────────────────────────────────────────────    │
│  💡 Press ⌘N anywhere to start a recording                  │
│  💡 Ask `/memory` "Who owns the Globex renewal?"            │
└─────────────────────────────────────────────────────────────┘
```

Differences from today:
- One subtitle line replaces the 4 StatCards (the cards were ego — the
  numbers don't move per-second).
- Recent notes list grows from 6 → 5 (matches sidebar).
- Add an **Open action items** quick-glance section (3 max). Click an item
  jumps to its source note.
- Replace the two QuickLink cards (Index folder / Ask memory) with a thin
  "Tips" section that rotates 2 of ~8 onboarding-aware tips.

### 3.3 Live recording — `/meeting/live`

**References**: `00.16.38` (idle / "Listening for speech…" with floating
pill), `00.18.16` (transcript flowing + toast "Recording saved successfully,
2 transcript segments saved · View Meeting"), `00.18.51` (live with three
toolbar tabs: Copy / Recording / Enhance plus right pane "Generate
Summary / AI Model / Template" + "Generating AI Summary…" spinner),
`00.25.03` (transcript + No Summary Yet right pane + Generate Summary CTA).

This is the most-used screen and Meetily gets the most polish here. Today
we have a two-pane (Transcript | Chat panel). We restructure to **three
horizontal toolbar groups + two panes**:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ◀ Back     Q4 planning sync      ● Recording   00:34          [• • •]   │
│                                                                          │
│  ⎘ Copy    🎙 Recording    ✦ Enhance     │       ✦ Generate Summary       │
│  ────────────  ─────────────  ──────────  │  🤖 AI Model    📋 Template   │
├──────────────────────────────────────────┼──────────────────────────────┤
│                                          │                              │
│   [00:02]  Hey everyone, welcome…        │                              │
│                                          │      No Summary Generated     │
│   [00:11]  And I wanted to share         │              Yet              │
│             this kind of update to a     │                              │
│                                          │   Generate an AI-powered     │
│   [00:25]  This amount was doing         │  summary of your transcript   │
│             something really              │   to get key points, action  │
│             interesting. We're trying    │       items, and decisions.  │
│             to fix this flashing issue   │                              │
│             with the drawer.             │     [  ✦ Generate Summary  ] │
│                                          │                              │
│   [00:37]  component on Safari?          │                              │
│                                          │                              │
│   [00:41]  Edge case browser specific…   │                              │
│                                          │                              │
│   ╭─ Listening… ─╮                       │                              │
│   ╰──────────────╯                       │                              │
│                                          │                              │
└──────────────────────────────────────────┴──────────────────────────────┘
                  ⏸  ⏺  ▌▌▌      (floating pill — hidden on this route)
```

**Top bar (sticky)**:
- Back arrow (← to Home).
- Editable title (click-to-rename, already shipped).
- Status badge: `● Recording 00:34` (red dot pulse).
- Right side: overflow `⋮` menu with Rename / Delete / Export / Retranscribe.

**Toolbar — Left side (transcript-actions group)**:
- **Copy**: copies full transcript to clipboard. Toast "Copied to clipboard".
- **Recording**: toggles record/stop (this is the **primary action** for
  this screen — it replaces the top-bar Start/Stop button). When idle this
  reads "Record"; when live it reads "Stop". Red when live.
- **Enhance**: opens a popover with two options:
  - "Clean filler words" (run a small post-pass that removes "um", "uh",
    "like" — quick, instant client-side regex).
  - "Retranscribe with another model" (opens the Retranscribe modal — §3.5).

**Toolbar — Right side (summary-actions group)**:
- **Generate Summary**: triggers `triggerPostMeeting` and shows the right
  pane in "Generating AI Summary…" state (spinner + skeleton). When done,
  right pane swaps to the structured summary.
- **AI Model**: opens the Model Settings modal (see §3.5).
- **Template**: opens a Template picker (see §3.5).

**Left pane — Transcript**:
- Each turn is a row: `[mm:ss]` timestamp chip (gray, mono, 11px) + the
  text (14px, leading 1.65).
- Turns are grouped by speaker gap (already implemented).
- "Listening…" indicator below the last turn when running and last-segment
  age > 2s (already implemented).
- Auto-scroll on new segment (already implemented).
- **NEW**: Click a `[mm:ss]` chip to copy that line's timestamp+text to
  clipboard.

**Right pane — Summary or Chat (tabs)**:

This is the biggest behavioral change. Today the right pane is **only
chat**. Meetily's right pane is **only summary**. The right answer is **a
2-tab selector**:

```
[ Summary ]  [ Copilot chat ]
```

Default tab: **Summary** when meeting is stopped, **Copilot chat** when
running. Persisted in localStorage per-route.

- **Summary tab content** (when summary not generated): Empty state with the
  big icon + "No Summary Generated Yet" + Generate button.
- **Summary tab content** (generating): Skeleton + "Generating AI Summary…"
- **Summary tab content** (generated): Structured view (see §3.4) — but
  scoped to fit in the side panel. We render only the Overview + Key
  Decisions + first 3 Action Items, with a "View full summary →" link to
  `/meeting/$id/summary`.
- **Copilot chat tab content**: same as today's chat panel.

**Floating pill** is NOT shown here (the in-page Recording toolbar button is
the primary action).

**Toast on stop**: when recording stops, show a green toast at the bottom-
left: "Recording saved successfully. 47 transcript segments saved. [View
Meeting]". Click "View Meeting" navigates to `/meeting/$id/summary`. Same
behavior as Meetily screenshot `00.18.16`.

### 3.4 Note detail — `/meeting/$id/summary`

**References**: `00.19.59` (the *editor* with toolbar above + structured
summary inline w/ Heading 1/2/3, Quote, Toggle list, Bullet/Numbered/Check
lists, Paragraph, Code block, Table, Image), `00.20.06` (slash menu),
`00.20.18` (Edit Meeting Title modal), `00.20.39` & `00.20.57` & `00.21.04`
(Settings General/Recordings/Transcription/Summary tabs), `00.26.07`
(transcript+summary side-by-side with Action Items table including Owner,
Task, Due, Reference Transcript Segment, Segment Time stamp).

Today our summary page is a single column with a top tab strip (Overview /
Decisions / Actions / Conflicts / Transcript). We rebuild it as **two-pane,
toolbar-driven**:

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ◀ Back        Q4 planning sync                       [Edit] [⋮ More]      │
│                                                                            │
│  ⎘ Copy   🎙 Recording (idle)    ✦ Enhance     │  ✦ Generate Summary       │
│                                                │  🤖 AI Model  📋 Template │
├────────────────────────────────────────────────┼────────────────────────────┤
│                                                │                            │
│  [00:02]  since I have the first item on the   │   Summary                  │
│           agenda, I'll share my screen…        │   The meeting focused on a │
│                                                │   persistent flashing issue│
│  [00:11]  And I wanted to share this kind      │   within Safari's drawer   │
│           of an update to a                    │   component, specifically  │
│                                                │   related to a browser-    │
│  [00:25]  This amount was doing something      │   specific bug…            │
│           really interesting. We're trying     │                            │
│           to fix this flashing issue with      │   Key Decisions            │
│           the drawer.                          │   • Investigate the root   │
│                                                │     cause of the flashing  │
│  [00:37]  component on Safari?                 │     issue in Safari's      │
│                                                │     drawer component.      │
│  [00:41]  Edge case browser specific           │   • Explore alternative    │
│           weird stuff. I don't know if you     │     solutions to address   │
│           remember this.                       │     the flashing issue.    │
│                                                │                            │
│  [00:45]  Um                                   │   Action Items             │
│                                                │   ┌──────────────────────┐ │
│  [00:47]  But the proposed fix was adding      │   │Owner│Task    │Due  │…│ │
│           this.                                │   │Chris│Investig│End  │ │ │
│                                                │   │     │a deeper│of   │ │ │
│  [00:51]  Which is also like man, this is      │   │     │analysis│Day  │ │ │
│           real kind of we're we're knee        │   │…                  │…│ │
│           deep and kinda…                      │   └──────────────────────┘ │
│                                                │                            │
│  [00:57]  Figure out how we can get things     │   Discussion Highlights    │
│           just working. And it's strange       │   • The initial stages of  │
│           that we would have to add this.      │     Lily's development     │
│           It's a little bit of a hacky line,   │     were largely unplanned │
│           but if we need it, we need it.       │     and messy…             │
│                                                │                            │
│  [01:06]  And so I do feel like approaching    │                            │
│           this M R could have taken two        │   Summary completed        │
│           different paths.                     │                            │
│                                                │                            │
│  [02:29]  This is our opposite.                │                            │
└────────────────────────────────────────────────┴────────────────────────────┘
```

Three big differences from today:

1. **Two-pane layout** — transcript permanently on the left, summary on the
   right, both scroll independently. Resizable splitter at 60/40 default
   (Meetily uses ~50/50 but we have less width on the right tabs).
2. **Toolbar above each pane**, mirroring the live screen so users learn
   the pattern once. The left side gets Copy / Recording / Enhance; the
   right side gets Generate Summary / AI Model / Template.
3. **Action Items rendered as a TABLE** with columns:
   `Owner | Task | Due | Reference Transcript Segment | Segment Time stamp`.
   Each task row's "Reference Transcript Segment" is clickable — clicking
   it scrolls the left transcript pane to that timestamp and highlights it
   for 1.5s.

**Editing the summary**: the summary pane is **editable** (contenteditable
or TipTap if we want a proper editor — see §6.4). Above the editor, a
toolbar matches Meetily's: `H1 ▾  •  ‒  ☑  ¶  ` (Heading / Quote / Toggle
list / Bullet / Numbered / Check / Paragraph / Code / Table / Image).
Typing `/` anywhere in the editor opens a **slash menu** (Meetily's exact
pattern, screenshot `00.20.06`):

```
Headings
  H1  Heading 1                    ⌘-Alt-1
  H2  Heading 2                    ⌘-Alt-2
  H3  Heading 3                    ⌘-Alt-3

Basic blocks
  ⎯  Quote                        Quote or excerpt
  ▶  Toggle List                   ⌘-Shift-6
  ☰  Numbered List                 ⌘-Shift-7
  ≣  Bullet List                   ⌘-Shift-8
  ☑  Check List                    ⌘-Shift-9
  ¶  Paragraph                     ⌘-Alt-0
  ⎄  Code Block                    ⌘-Alt-c

Advanced
  ⊞  Table
Media
  🖼  Image
```

Editor body is persisted to the meeting's `summary_md` field (we add this
field to the backend — see §5).

**Edit Meeting Title modal**:
- Triggered by clicking the [Edit] button (or the title itself).
- Modal centered, white card, `rounded-2xl`, max-width 480px:

```
┌─────────────────────────────────────────────┐
│  Edit Meeting Title                  [X]    │
│                                              │
│  Meeting Title                               │
│  ┌────────────────────────────────────────┐ │
│  │ Lily: A Productivity App in the Making │ │
│  └────────────────────────────────────────┘ │
│                                              │
│                       [ Cancel ]  [  Save  ]│
└─────────────────────────────────────────────┘
```

Behavior matches Meetily screenshot `00.20.06.png`.

**Overflow menu (⋮)**:
- Edit title
- Retranscribe meeting… (opens Retranscribe modal — §3.5)
- Duplicate
- Export as Markdown
- Export as PDF
- Delete (destructive, red, confirms)

**Conflict drawer**: when conflicts exist, a red banner appears above the
right pane: `⚠ 2 conflicts detected with prior meetings. [Review →]`.
Clicking opens a drawer (right side, slides over the summary pane) with
the conflict cards. We keep the existing styling for the conflict cards.

### 3.5 Modals & dialogs

**Model Settings modal** (`00.19.20`, `00.19.27`, `00.19.34`):

Triggered from `AI Model` toolbar button on Live or Summary screens, and
from Settings → Summary tab.

```
┌─────────────────────────────────────────────────────────┐
│   Model Settings                                  [X]   │
│                                                          │
│   Summarization Model                                    │
│   ┌────────────────────────────────────────────────┐ ▼ │
│   │ Built-in AI (Offline, No API needed)            │   │
│   └────────────────────────────────────────────────┘   │
│      ▾ dropdown options:                                 │
│         ✓ Built-in AI (Offline, No API needed)          │
│           Claude                                         │
│           Custom Server (OpenAI)                         │
│           Groq                                           │
│           Ollama                                         │
│           OpenAI                                         │
│           OpenRouter                                     │
│                                                          │
│   Built-in AI Models                                     │
│   ┌─────────────────────────────────────────────────┐  │
│   │  Gemma 3 1B (Fast)        ● Ready  [Selected]   │  │
│   │  Fastest model. Runs on any hardware            │  │
│   │  with ~1GB RAM. Good for quick summaries.       │  │
│   │  1019MB · 32768 tokens                          │  │
│   └─────────────────────────────────────────────────┘  │
│   ┌─────────────────────────────────────────────────┐  │
│   │  Gemma 3 4B (Balanced)    Not Downloaded   ⬇    │  │
│   │  Balanced model. Great quality/speed trade-off. │  │
│   │  Requires ~3.5GB RAM.                           │  │
│   │  2374MB · 32768 tokens                          │  │
│   └─────────────────────────────────────────────────┘  │
│                                                          │
│                                            [   Save   ] │
└─────────────────────────────────────────────────────────┘
```

We adapt: replace `Gemma 3 1B/4B` with `qwen2.5:3b-instruct` /
`qwen2.5:7b-instruct` (the models we already recommend). The "Not
Downloaded" state has an inline Download button that triggers
`ollama_pull` and shows a per-card progress bar.

When user picks Claude/OpenAI/Groq/OpenRouter from the dropdown, the modal
adds an API Key input field below (screenshot `00.23.12`):

```
   Summarization Model                                  
   ┌──────────────────────────────────────────────┐ ▼   ┌───────┐
   │ OpenAI                                       │     │ gpt-4o│ ▾
   └──────────────────────────────────────────────┘     └───────┘
                                                         (model variant)
   API Key
   ┌──────────────────────────────────────────────┐ 👁
   │ Enter your API key                           │
   └──────────────────────────────────────────────┘

                                            [Save]    (disabled until non-empty)
```

The API key is stored in macOS Keychain (we have a Tauri command for this
already from the earlier BYOK discussion).

**Retranscribe modal** (`00.26.07`):

Triggered from the summary screen overflow menu or Enhance toolbar dropdown.

```
┌────────────────────────────────────────────────┐
│   ⟳  Retranscribe Meeting                [X]   │
│   Re-process the audio with different language │
│   settings.                                     │
│                                                │
│   🌐 Language                                  │
│      Language selection isn't supported for    │
│      Parakeet. It always uses automatic        │
│      detection.                                 │
│                                                │
│   🧠 Model                                     │
│   ┌──────────────────────────────────────┐ ▼  │
│   │ ✦ Parakeet: parakeet-tdt-0.6b-v3…    │    │
│   └──────────────────────────────────────┘    │
│                                                │
│      Choose a transcription model.            │
│                                                │
│              [ Cancel ]  [ ⟳ Start Retranscribing ] │
└────────────────────────────────────────────────┘
```

We adapt: replace Parakeet with our Whisper model list. The user picks any
downloaded Whisper variant and we run the transcription against the saved
audio file (already on disk — we kept it for this purpose).

**Edit Meeting Title modal** — already specified in §3.4.

**Template picker modal** (new — Meetily references this without showing
its picker; we design ours):

Triggered from `Template` toolbar button on Live and Summary screens.

```
┌────────────────────────────────────────────────────┐
│   Summary Template                            [X]  │
│   Pick a template to control what the AI extracts. │
│                                                    │
│   ┌─────────────────────────────────────────────┐ │
│   │ ● Default                          ✓        │ │
│   │   Overview + Key Decisions + Action Items   │ │
│   │   + Highlights                              │ │
│   └─────────────────────────────────────────────┘ │
│   ┌─────────────────────────────────────────────┐ │
│   │ ○ Standup                                   │ │
│   │   Yesterday / Today / Blockers per person   │ │
│   └─────────────────────────────────────────────┘ │
│   ┌─────────────────────────────────────────────┐ │
│   │ ○ Sales Call                                │ │
│   │   BANT + objections + next steps            │ │
│   └─────────────────────────────────────────────┘ │
│   ┌─────────────────────────────────────────────┐ │
│   │ ○ Interview                                 │ │
│   │   Themes + quotes + follow-ups              │ │
│   └─────────────────────────────────────────────┘ │
│   ┌─────────────────────────────────────────────┐ │
│   │ + Create custom template                    │ │
│   └─────────────────────────────────────────────┘ │
│                                                    │
│                            [ Cancel ]  [ Apply ]  │
└────────────────────────────────────────────────────┘
```

Each template is a stored Pydantic schema + prompt template on the backend.
v1 ships with Default + Standup + Sales Call + Interview built in.

### 3.6 Settings — `/settings`

**References**: `00.20.39` (General — Notifications toggle, Data Storage
Locations, Usage Analytics, Your User ID, privacy footer), `00.20.57` &
`00.21.04` (Recordings — Save Audio toggle, Save Location, File Format,
Recording Start Notification, Default Audio Devices, System Audio Backend
selector w/ ScreenCaptureKit vs Core Audio cards), `00.21.24` (Transcription
— Transcript Model dropdown with Parakeet/Local Whisper/Compact), `00.22.03`
& `00.22.09` (Transcription model list with Small/Medium/Large
V3/Compressed/Turbo/Standard + Advanced Models foldout with whisper-*-q5_1
variants — Balanced+ tags), `00.22.45` (Summary — Auto Summary toggle +
Summary Model Configuration with Built-in AI models), `00.23.12` (Summary
with custom OpenAI + API Key input).

We adopt the **sub-tab nav** at the top: `General | Recordings |
Transcription | Summary | Beta`.

```
┌──────────────────────────────────────────────────────────────────┐
│  ◀ Back     Settings                                              │
│                                                                   │
│  ────────────────────────────────────────────────────────────     │
│   ⊕ General  🎙 Recordings  ⌗ Transcription  ✦ Summary  ⚗ Beta    │
│  ────────────────────────────────────────────────────────────     │
│                                                                   │
│  (content for selected tab)                                       │
└──────────────────────────────────────────────────────────────────┘
```

**General tab content**:
- **Notifications** — toggle. "Enable or disable notifications of start and
  end of meeting." (matches Meetily verbatim.)
- **Data Storage Locations** card. Shows `/Users/.../Library/Application
  Support/Meetwit/recordings/`. Buttons: Open Folder, Change…
- **Usage Analytics** card. Anonymous usage patterns only. Toggle.
  - **Your User ID** — read-only input + Copy button. We already generate a
    UUID per-install. Surface it here so users can reference it in bug
    reports.
- Privacy footer: "Your meetings, transcripts, and recordings remain
  completely private and local. View Privacy Policy".

**Recordings tab content**:
- **Save Audio Recordings** toggle. "Automatically save audio files when
  recording stops." Defaults ON.
- **Save Location** card. Same as Data Storage Locations folder. Open
  Folder button.
- **File Format**: read-only WAV (we use whisper.cpp's input format) or
  MP4 (Meetily uses MP4). Decision: ship as WAV for v1 (already implemented),
  document the choice, allow MP4 v1.1 via ffmpeg.
- **Recording Start Notification** toggle. "Show reminder to inform
  participants when recording starts." A small bordered banner pops in the
  bottom-right of the live screen at the moment recording begins, reading
  "🔴 Meetwit is recording. Inform your participants." Auto-dismisses
  after 5s.
- **Default Audio Devices** card with two dropdowns: Microphone and System
  Audio. We populate from `cpal::devices()`.
- **System Audio Backend** card with two radio cards (matches Meetily
  exactly):
  - ScreenCaptureKit — "Apple's ScreenCaptureKit framework — Higher level
    API with good compatibility" (Disabled if macOS < 14.0)
  - **Core Audio** — "Direct Core Audio API — Lower latency, more control
    over audio pipeline" (Active by default)
  - Footnote: "• Backend selection only affects system audio capture
    • Microphone always uses the default method
    • Changes apply only to new recording sessions"

**Transcription tab content**:
- **Transcript Model** dropdown (single-select). Options:
  - `✨ Parakeet (Recommended - Real-time / Accurate)` (v1.1 — needs ONNX
    runtime work; show as "Coming soon")
  - `🐢 Local Whisper (High Accuracy)` — selected by default
  - `Compact` (a small variant we ship for low-RAM machines)
- When Local Whisper is selected, a model list appears (matches Meetily
  screenshot `00.22.03`):

```
🔥 Small        · Moderate speed · Good accuracy
   466MB  ✦ Good accuracy  ⚡ Medium processing                [Download]

🔥 Medium       · Moderate speed · Professional quality, optimized  [Balanced]
   514MB  ✦ High accuracy  ⚡ Medium processing                [Download]

🔥 Large V3 Compressed · Slower processing · Most accurate, optimized  [Balanced]
   1.0GB  ✦ High accuracy  ⚡ Slow processing                  [Download]

🔥 Large V3 Turbo · Moderate speed · Best accuracy with speed
   1.5GB  ✦ High accuracy  ⚡ Medium processing                [Download]

🔥 Large V3     · Slower processing · Most accurate
   3.0GB  ✦ High accuracy  ⚡ Slow processing                  [Download]
```

A foldout **Advanced Models ▾** below it exposes the `whisper-*-q5_1`
quantized variants for power users.

The current row (the active model) shows ● Active in green where the
Download button was. Each model card has the same icon set: 💾 (size),
✦ (accuracy tier), ⚡ (processing speed).

While a download is in progress, a floating download tile appears
top-right (same component as the onboarding screen, screenshot `00.22.03`
top-right corner).

**Summary tab content**:
- **Auto Summary** toggle. "Auto Generating summary after meeting
  completion (Stopping)" Defaults ON.
- **Summary Model Configuration** card:
  - **Summarization Model** dropdown — same options as Model Settings
    modal.
  - **Built-in AI Models** list. Two cards (Gemma 3 1B Fast / Gemma 3 4B
    Balanced) — but we replace with `qwen2.5:3b-instruct (Fast)` and
    `qwen2.5:7b-instruct (Balanced)`.
  - When user picks Claude / OpenAI / Groq / etc.: shows API Key input +
    model variant dropdown (gpt-4o for OpenAI, etc.).
  - **Save** button bottom-right.

**Beta tab content**:
- A simple list of experimental flags with toggles:
  - ☐ Two-pass transcription (live tiny.en → final medium.en)
  - ☐ Speaker diarization (pyannote, requires Python sidecar)
  - ☐ Realtime partial transcripts (10s → 2s windows)
  - ☐ Conflict detection (cross-meeting)
- Each toggle has a "Learn more" link to a markdown doc opened in a modal.

### 3.7 Documents (was Knowledge) — `/knowledge`

Minor changes. Today's screen is mostly good. Adjustments:

- Eyebrow label: "Workspace" → "Documents".
- Page title: "Knowledge base" → "Documents".
- The "Index a folder" hero card stays.
- Stat tiles (Documents / Failed / Chunks / Last indexed) stay.
- Document list gets a **search input** above it: `🔍 Search documents…`
  (client-side filter on filename and path).
- Each document row shows the **embedding model** used (a small tag, e.g.
  `nomic-embed-text` or `all-MiniLM-L6-v2`). Helps power users.

### 3.8 Ask my notes (was Memory) — `/memory`

Today's memory page is already chat-ish. Changes:

- Eyebrow label: "Search" instead of "Memory".
- Page title: "Ask my notes" (replaces "Ask your memory" — gentler).
- Suggestions row at the top: shows 4 dynamically-generated suggestions
  based on the user's most-recent meeting topics (or stock suggestions if
  no meetings yet).
- Add a **scope picker** above the composer: `All notes ▾` dropdown lets
  the user constrain memory to e.g. "Last 7 days" / "Project: Lily" /
  "Only documents" / "Only meetings". Defaults to All.
- Citations get the new chip styling (already shipped).
- Add **streaming source highlight**: as the LLM streams, when it emits a
  `[D 2]` chip, the corresponding source card on the right pulses brand
  for 600ms to draw attention.

### 3.9 Action items (was Tasks) — `/tasks`

Today's screen is good. One change:

- Add **Owner filter** chip row above the list: `All · You · Sara · Chris ·
  Unassigned`. Populated from `distinct(owner)` across all action items.
- Each row gains a **reference link** showing `from "Q4 planning sync ·
  02:14"`. Clicking jumps to that timestamp in the source meeting.

### 3.10 Empty workspace state (NEW)

When the user opens Meetwit for the first time *post-onboarding* and the
database is empty, Home shows:

```
                ✦
        Welcome to Meetwit

  You haven't recorded any meetings yet.

  ┌────────────────────────────────────┐
  │  ⏺  Record your first meeting       │
  │     Hit the button — we'll handle   │
  │     audio, transcription, and       │
  │     summary.                        │
  │                  [ Start Recording] │
  └────────────────────────────────────┘

  ┌────────────────────────────────────┐
  │  📁  Or index a folder of docs     │
  │     Bring PDFs and Markdown so you  │
  │     can ask "what did we decide…"   │
  │                  [ Index a folder ] │
  └────────────────────────────────────┘

         (Skip · Tour Meetwit (45s))
```

The "Tour Meetwit (45s)" link opens an in-app coachmark walkthrough — see
§4.

---

## 4. New components to build

These are the concrete React components added by this plan. Each is small;
each has one job.

| Component | Purpose | Lines (est) |
| --- | --- | --- |
| `RecordingPill` (NEW) | Floating bottom-center pill with Pause / Stop / Waveform. Mounts at `__root.tsx` level. Hides on `/meeting/live`. | ~80 |
| `WaveformBars` (NEW) | Three animated SVG bars driven by `lastRms` from store. Smooth interpolation. | ~40 |
| `SidebarNotesList` (NEW) | Persistent meeting list in sidebar (top 6 + "see all"). Polls/subscribes to `useMeetings`. | ~70 |
| `SidebarSearch` (NEW) | Global search input at top of sidebar. Opens a `<CommandPalette>` overlay (cmd+k). | ~50 |
| `CommandPalette` (NEW) | Spotlight-style modal with fuzzy search across notes, docs, and quick actions. ⌘K. Uses `cmdk` (already a popular small dep). | ~120 |
| `Toolbar` (NEW) | Generic horizontal toolbar with grouped buttons. Used on Live + Summary screens. Variants: `transcript-actions`, `summary-actions`. | ~60 |
| `ToolbarButton` (NEW) | A small icon+label button. Active state, disabled state, dropdown variant. | ~40 |
| `ModelSettingsModal` (NEW) | The Model Settings dialog from §3.5. | ~180 |
| `RetranscribeModal` (NEW) | The Retranscribe dialog from §3.5. | ~120 |
| `EditTitleModal` (NEW) | The Edit Meeting Title dialog from §3.5. | ~50 |
| `TemplatePickerModal` (NEW) | The Template picker dialog from §3.5. | ~100 |
| `SummaryEditor` (NEW) | The TipTap-based or contenteditable summary editor with slash menu + toolbar. See §6.4. | ~250 |
| `SlashMenu` (NEW) | The keyboard-driven block picker inside the editor. | ~100 |
| `TwoPaneSplitter` (NEW) | Resizable horizontal split with persisted ratio. Used on `/meeting/$id/summary`. | ~60 |
| `ToastStack` (NEW) | Bottom-left toast container. Used for "Recording saved successfully — View Meeting". Auto-dismiss + manual dismiss. | ~70 |
| `ActionItemsTable` (NEW) | The table from §3.4 with sortable columns + clickable "Reference Transcript Segment" cells. | ~150 |
| `ModelDownloadCard` (NEW) | A per-model card with size/accuracy tags + Download button or progress bar. Used in Onboarding + Settings → Transcription. | ~80 |
| `FloatingDownloadTile` (NEW) | The corner download tile from screenshot `00.09.55`. Listens to `model-download-progress` events. | ~60 |
| `AudioDeviceSelect` (NEW) | A dropdown of `cpal::devices()`. Used in Settings → Recordings. | ~40 |
| `SystemAudioBackendCard` (NEW) | The radio-card selector for SCK vs Core Audio. | ~50 |
| `Tabs` (NEW) | A small primitive: `<Tabs value onChange>` with `<TabBar>` + `<TabPanel>`. Used in Settings and the right-pane of Live. | ~50 |

All components live in `desktop/src/components/`; new modals in
`desktop/src/components/modals/`; new editor in
`desktop/src/components/editor/`.

---

## 5. Backend additions

These are the few backend changes (Rust + Python) needed to support the new
UI surface. None are functionality-breaking.

### 5.1 Persisted `summary_md` field

Add a `summary_md TEXT` column to the `meetings` table. Wire it through the
Pydantic `Meeting` schema and the `PATCH /meetings/{id}` endpoint. The
editor in §3.4 writes here. The auto-generated summary continues to
populate the existing structured `SummaryOut` (overview/key_points/etc.)
but also a markdown-rendered version of it on `summary_md` so the editor
opens with content.

### 5.2 Templates

Add `summary_templates` table:
- `id` (uuid)
- `name` (text)
- `description` (text)
- `system_prompt` (text)
- `output_schema` (json — Pydantic v2 schema)
- `is_builtin` (bool)
- `created_at` (timestamp)

Seed with Default / Standup / Sales Call / Interview. Add CRUD endpoints.
The post-meeting endpoint accepts an optional `template_id` query param.

### 5.3 Recording artifacts

The audio file is currently dropped at meeting end. Keep it. Save to
`~/Library/Application Support/Meetwit/recordings/<meeting_id>.wav`. Used
by:
- Retranscribe modal (§3.5).
- Settings → Recordings → "Open Folder".
- Future v1.1 audio playback in the transcript pane.

Add a `recording_path` field on `Meeting`. Cleanup policy: keep all
recordings forever, surface a "Delete recording" entry in the overflow
menu for users who want to reclaim disk.

### 5.4 Provider config

Add a `provider_config` table for BYOK:
- `provider` (text — "openai" / "anthropic" / "groq" / "openrouter")
- `api_key_keychain_ref` (text — opaque reference into macOS Keychain)
- `model` (text — "gpt-4o", "claude-sonnet-4-7", etc.)
- `enabled_for` (text — "summary" / "memory" / "live_copilot" / "all")

The Tauri shell exposes `set_provider_key`, `clear_provider_key`,
`list_provider_configs` commands. Keys stored in macOS Keychain via the
existing `security` crate binding.

### 5.5 Unified download progress event

Today we emit `whisper-download-progress`. Add a generic
`model-download-progress` event:
```json
{
  "model_id": "whisper-medium.en" | "qwen2.5:3b-instruct" | ...,
  "kind": "whisper" | "ollama",
  "bytes_done": 12345,
  "bytes_total": 67890,
  "rate_bps": 4123456,
  "finished": false,
  "error": null
}
```

The onboarding floating tile and Settings download tile both subscribe to
this. Keep `whisper-download-progress` as an alias for backward compat.

### 5.6 Conflict review badge

Add `unresolved_conflict_count` to the meeting summary endpoint so the
header banner (§3.4) can render without an extra round-trip.

---

## 6. Implementation order

To minimize churn and keep `pnpm typecheck` / `pnpm lint` / `cargo clippy`
green throughout, ship in **five sequenced phases**. Each phase is a
mergeable PR.

### 6.1 Phase 1 — Design tokens + sidebar

Goal: visual shift to near-white sidebar; product feels different at a
glance.

Files:
- `desktop/src/styles.css` (palette tweaks)
- `desktop/src/components/SideNav.tsx` (lighter palette, search input slot,
  notes list slot)
- `desktop/src/components/SidebarSearch.tsx` (NEW, opens CommandPalette)
- `desktop/src/components/SidebarNotesList.tsx` (NEW)
- `desktop/src/components/CommandPalette.tsx` (NEW, using `cmdk` if added,
  otherwise hand-rolled fuzzy in ~120 lines)
- `desktop/src/components/RecordingBadge.tsx` (re-styled for light bg)
- `desktop/src/routes/__root.tsx` (host the search + notes list in
  sidebar)

Verification:
- All screens still render.
- Sidebar text is dark-on-light (not light-on-dark).
- Notes list shows when meetings exist; collapses cleanly when none.
- ⌘K opens a placeholder command palette.

### 6.2 Phase 2 — Floating Recording pill + Live screen toolbar

Files:
- `desktop/src/components/RecordingPill.tsx` (NEW)
- `desktop/src/components/WaveformBars.tsx` (NEW)
- `desktop/src/routes/__root.tsx` (mount `<RecordingPill>` at root)
- `desktop/src/routes/meeting.live.tsx` (replace top-bar Stop button with
  the new Toolbar component; introduce the Summary/Copilot tabs)
- `desktop/src/components/Toolbar.tsx` (NEW)
- `desktop/src/components/Tabs.tsx` (NEW)
- `desktop/src/components/ToastStack.tsx` (NEW)
- `desktop/src/stores/meetingStore.ts` (add `lastRms` writes from mic stream)
- `desktop/src-tauri/src/audio/*` (emit RMS over an event ~10 Hz)

Verification:
- Start a recording from Home, navigate to Documents — pill is visible at
  the bottom and tracks elapsed time.
- Stop from the pill works.
- Bars animate roughly in sync with speech.
- Stopping shows the toast with "View Meeting".

### 6.3 Phase 3 — Note detail two-pane + Action Items table + Edit Title

Files:
- `desktop/src/routes/meeting.$id.summary.tsx` (full rewrite to two-pane
  layout, drop tab strip)
- `desktop/src/components/TwoPaneSplitter.tsx` (NEW)
- `desktop/src/components/ActionItemsTable.tsx` (NEW)
- `desktop/src/components/modals/EditTitleModal.tsx` (NEW)
- `desktop/src/components/modals/RetranscribeModal.tsx` (NEW)
- backend: add `recording_path` to `Meeting`; add `POST /meetings/{id}/retranscribe`
- backend: keep audio file after meeting stop

Verification:
- Open any historical meeting — left pane shows transcript; right shows
  summary or "Generate Summary" empty state.
- Clicking a row's "Reference Transcript Segment" cell scrolls the left
  pane and highlights the line.
- Edit Title modal updates the meeting; sidebar list reflects the change.

### 6.4 Phase 4 — Summary editor with slash menu

This is the biggest single piece. Pick **TipTap** (peer dep
`@tiptap/react`, ~80KB gzipped, has a clean extension API and matches
Meetily's editor behavior exactly).

Files:
- `desktop/src/components/editor/SummaryEditor.tsx` (NEW, TipTap setup)
- `desktop/src/components/editor/SlashMenu.tsx` (NEW, custom suggestion ext)
- `desktop/src/components/editor/Toolbar.tsx` (NEW, the H1/H2/H3/Quote/etc.
  bar above the editor)
- backend: add `summary_md TEXT` column + migration; wire through `PATCH
  /meetings/{id}`

Add deps:
```json
"@tiptap/react": "^2.x",
"@tiptap/starter-kit": "^2.x",
"@tiptap/extension-task-list": "^2.x",
"@tiptap/extension-task-item": "^2.x",
"@tiptap/extension-table": "^2.x",
"@tiptap/extension-code-block-lowlight": "^2.x",
"@tiptap/extension-image": "^2.x",
"@tiptap/suggestion": "^2.x"
```

Verification:
- Type `/` in the summary pane — menu opens, arrow keys navigate, Enter
  inserts a block.
- Refreshing the page preserves the edit.
- Switching from Summary to Copilot tab on the Live screen doesn't lose
  unsaved edits.

### 6.5 Phase 5 — Onboarding rewrite + Settings sub-tabs

Files:
- `desktop/src/routes/onboarding.tsx` (rewrite to 4-step pattern)
- `desktop/src/components/ModelDownloadCard.tsx` (NEW)
- `desktop/src/components/FloatingDownloadTile.tsx` (NEW)
- `desktop/src/routes/settings.tsx` (rewrite to sub-tabs General/Recordings/
  Transcription/Summary/Beta)
- `desktop/src/components/modals/ModelSettingsModal.tsx` (NEW)
- `desktop/src/components/modals/TemplatePickerModal.tsx` (NEW)
- backend: `summary_templates` table + seed + endpoints
- backend: `provider_config` table + macOS Keychain Tauri commands
- backend: unified `model-download-progress` event + `ollama_pull` Tauri
  command

Verification:
- Fresh install: onboarding walks through 4 steps; each model card shows
  progress; floating tile mirrors the active download; Continue activates
  on completion.
- Settings → Recordings → toggling Save Audio respects the choice on the
  next recording.
- Settings → Summary → switching to "OpenAI" + entering a fake API key →
  Save → key stored in Keychain (verified via `security find-generic-
  password -s meetwit-openai`).

---

## 7. Accessibility & polish (cross-cutting)

These are enforced via lint + manual check at the end of each phase.

- Every interactive element has a visible focus ring (`focus-visible:ring-2
  focus-visible:ring-brand-500/40 focus-visible:ring-offset-2`).
- Tab order matches reading order. Modal dialogs trap focus and return on
  close.
- All icon-only buttons have `aria-label`.
- Recording status is announced to AT via `<span role="status" aria-live="polite">`.
- Reduced-motion users get no waveform animation (we already respect this
  in `styles.css`).
- Color contrast: every text/background pair must hit WCAG AA. The light-on-
  light sidebar must keep `text-zinc-700` minimum on `--color-sidebar-bg`
  (#f7f7f8). Verified via `npm run a11y` (Playwright + axe-core, ~5s run).

---

## 8. What we explicitly DON'T copy from Meetily

This isn't blind mimicry. The differences below are intentional.

- **Black-on-white aesthetic** → we use indigo brand. Meetily reads as a
  neutral tool; Meetwit has an opinion (privacy-first, RAG-grounded).
- **No "Beta" features menu in nav** — Meetily exposes a Beta tab in
  Settings. We do too, but we don't put a `[Beta]` badge in the sidebar
  next to entries. Less noise.
- **No "Recording in progress…" disabled button in the sidebar** — Meetily
  renders the Start CTA in a faded red state while live, alongside a
  separate floating pill. We render only the floating pill; the sidebar
  CTA disappears entirely while recording (it's not addressable anyway,
  since we're already in a recording).
- **No "Meeting Notes" wordmark wraparound** — Meetily uses the term
  "Meeting Notes" in the sidebar group header. We use "Notes" — shorter,
  matches the cleaner copy elsewhere.
- **No "Import Audio"** in the sidebar primary slot. Meetily exposes import
  as a primary action; for us it's a Settings → Recordings sub-action or
  a Home empty-state card. Why: importing is a power-user action and
  doesn't belong in the always-visible footer.

---

## 9. Out of scope (deferred to v1.1+)

- Calendar integration (auto-detect upcoming meetings from Google Calendar)
- Speaker diarization (pyannote)
- Real-time partial transcripts (2s windows vs 10s)
- Auto-update flow + signed releases (requires Apple Developer enrollment)
- Mobile companion app
- Audio playback in the transcript pane (waveform scrubber)
- PDF / DOCX export of summaries (covered as v1.1)
- Tray/menubar indicator while recording (out of scope until macOS tray API
  is stable in Tauri 2)
- Multi-account / team sync — Meetwit stays single-user, local-only

---

## 10. Acceptance — when is this "done"?

The acceptance bar mirrors the user's frustration vs. Meetily:

1. **Sidebar test**: open Meetwit, take a screenshot, paste alongside
   Meetily's homepage. A neutral reviewer (no context) should not say
   "Meetwit looks much less polished".
2. **Two-pane test**: every existing E2E test still passes. New test:
   summary screen renders both transcript and summary; the splitter
   persists its ratio in localStorage.
3. **Floating pill test**: start a recording, navigate to Settings, click
   Stop on the pill — recording stops, toast appears, "View Meeting" link
   in toast routes to the summary screen.
4. **Onboarding test**: fresh install on a wiped data folder walks 4 steps,
   downloads both models, and lands on Home with `meetings.length === 0`
   empty state.
5. **Editor test**: open any summary, type `/`, pick "Bullet List", type
   three lines, refresh — content survives. Type ⌘B to bold.
6. **Permission test**: macOS permissions prompt only when the user clicks
   "Enable" on the Permissions step — not on app launch.
7. **Keyboard test**: ⌘N starts a recording from any route. ⌘K opens the
   command palette from any route. Esc closes any open modal.

All seven must pass before we tag this as shipped.

---

## 11. v1.1 follow-ups surfaced by this plan

These came up while writing this plan but don't belong in v1:

- **Merge `/memory` into the global command palette**. Today they're two
  separate places to "ask things"; the only difference is scope (a single
  meeting vs. all knowledge). After v1 ships, the right move is to make
  ⌘K the universal asker, with a scope chip the user can change. The
  `/memory` route then becomes the "search results / chat history" view.
- **Embed audio playback** in the transcript turn rows. Click a `[mm:ss]`
  chip → mini-scrubber appears inline. Use `wavesurfer.js`.
- **Calendar tab in Home**. "Upcoming today: 3 meetings. Click any to
  start a recording attached to that calendar event."
- **Meeting-to-meeting linking**. "This decision conflicts with the one
  in Q3 sales sync" should be a real hyperlink to the source meeting,
  scrolled to the source line.
- **Per-user Tips engine**. The "Tips" section on Home (§3.2) should be
  driven by a small JSON file of tips with `condition` predicates (e.g.
  "show this if user has 0 indexed documents").

---

## 12. Risk register

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| TipTap bundle bloat | M | Audit `pnpm build` size; if > 200KB added, swap for contenteditable + a smaller block-toolbar lib (e.g. `tiptap-markdown` only). |
| Floating pill conflicts with Tauri window decorations | L | Test on macOS 12/13/14. The pill is plain HTML; should be fine. |
| `cmdk` adds a heavy peer dep | L | Build hand-rolled — fuzzy-search via `fuse.js` (8KB) or a 50-line Damerau-Levenshtein. |
| Sidebar notes list polls and burns CPU | M | Subscribe to `meetings-changed` event from the backend instead of polling. |
| TipTap collab features conflict with our local-first model | L | Only install the non-collab core; skip `@tiptap/extension-collaboration`. |
| Onboarding download events race with Ollama install | M | Add a precondition step: detect `ollama` binary; if missing, show inline "Install Ollama" sub-flow before starting the model pull. |
| Slash menu collides with code-block forward-slash typing | M | Disable the trigger inside code blocks via TipTap's `editor.isActive('codeBlock')` check. |

---

## 13. Effort estimate

- **Phase 1** (sidebar + tokens): 1–2 days.
- **Phase 2** (pill + Live toolbar + tabs): 2 days.
- **Phase 3** (two-pane summary + Action Items table + modals): 2–3 days.
- **Phase 4** (TipTap editor + slash menu): 3 days.
- **Phase 5** (onboarding + settings sub-tabs + BYOK keychain): 3–4 days.
- **Polish + a11y + manual QA**: 1–2 days.

Total: **~12–16 dev-days** for one person working full-time.

---

## 14. Open questions (resolve before Phase 1)

None blocking. The plan picks reasonable defaults for everything Meetily
shows. The most ambiguous choice — TipTap vs. contenteditable — is
reversible at Phase 4 boundary, so we don't need an answer now.
