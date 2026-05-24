# Meetwit UX Overhaul — Plan

## Context

V1 is functionally complete and end-to-end working (live transcript, RAG Q&A, post-meeting AI, all 9 routes). But after first hands-on testing the user flagged three concrete UX problems:

1. **State doesn't survive navigation.** Click "Start meeting" → speak → switch to another tab → come back → all transcript and recording state in the React component is gone, even though the Rust core is still capturing. There is also no indicator in any other tab that recording is ongoing — a serious trust issue.
2. **Live transcript feels laggy.** Whisper runs on a 10-second window. Between transcript emissions the UI shows "Listening…" static text and the user wonders if the app is broken.
3. **Visual design feels like an alpha.** Pervasive `bg-neutral-950` dark theme, mono unicode glyphs (●, ◼, ⚙) instead of real icons, no hierarchy, no breathing room. Compared to Meetily's polished light-theme tool with rounded cards, real SVG icons, and a colored backdrop, ours reads as "engineering prototype".

User wants a single coherent pass that turns Meetwit from "demo that works" into "professional tool I'd show a client".

## Locked decisions

- **Visual direction**: Linear-style minimal (NOT mimic Meetily). White background, dark slim sidebar, generous whitespace, single accent color (kept brand green for now — easy to retheme later), real Lucide SVG icons replacing all unicode glyphs, refined typography hierarchy.
- **Transcript cadence**: Keep 10s ASR windows (small.en quality is good, and shorter windows can hurt accuracy). Add a "listening…" animation between segments so dead-air feels alive.
- **State persistence**: Lift meeting state to a global Zustand store at app root. Subscribe to `transcript-update` once at app startup, not inside the meeting component. Add a persistent recording badge in the sidebar that's visible from any tab. Meeting screen reads from the global store.
- **Scope**: All-in — full theme refresh + state lifting + transcript polish + every screen reworked in one pass. One coherent design language end to end.

## Critical files

### To modify

- `desktop/src/styles.css` — switch root theme tokens from dark to light, add new design tokens
- `desktop/src/index.html` — body class swap from dark to light
- `desktop/src/routes/__root.tsx` — restructure layout, host the global recording badge
- `desktop/src/components/SideNav.tsx` — rebuild with Lucide icons, lighter palette, recording indicator
- `desktop/src/routes/index.tsx` — Home redesign
- `desktop/src/routes/meeting.live.tsx` — major rewrite: pull state from store, add listening animation, auto-scroll
- `desktop/src/routes/meeting.$id.summary.tsx` — restyle but keep structure
- `desktop/src/routes/knowledge.tsx`, `memory.tsx`, `tasks.tsx`, `settings.tsx`, `onboarding.tsx` — restyle for light theme
- `desktop/package.json` — add `lucide-react` (already present as dep, just need to use it)
- `desktop/index.html` — page background color swap

### To create

- `desktop/src/stores/meetingStore.ts` — Zustand store: meeting, segments, running flag, last RMS, listening animation tick
- `desktop/src/stores/index.ts` — barrel
- `desktop/src/lib/meetingLifecycle.ts` — extract the "start/stop meeting" sequence out of the component into a callable function that operates on the store (so the global subscription works without mounting `/meeting/live`)
- `desktop/src/components/RecordingBadge.tsx` — pulsing red dot + elapsed time + "stop" button, shown in sidebar when `running === true`
- `desktop/src/components/Listening.tsx` — animated three-dot indicator shown between transcript segments
- `desktop/src/components/Button.tsx`, `Card.tsx`, `Input.tsx`, `Badge.tsx` — small set of reusable primitives in the new design language. Tiny — each ~30 lines. Replaces inline class soup across all screens.
- `desktop/src/components/Empty.tsx` — friendly empty-state component (icon + headline + helper text + optional CTA)

### Not touched (intentionally)

- Rust backend (`desktop/src-tauri/src/**`) — the ASR window stays at 10s, no behavior changes. Backend is already good enough.
- Python sidecar — no changes needed
- All tests, CI, build scripts

## Design system

### Theme tokens (in `styles.css`)

```css
@theme {
  /* Surfaces */
  --color-bg:         #ffffff;
  --color-surface:    #fafafa;     /* card backgrounds */
  --color-surface-2:  #f4f4f5;     /* hovered / nested */
  --color-border:     #e4e4e7;
  --color-border-strong: #d4d4d8;

  /* Text */
  --color-text:       #18181b;     /* headings */
  --color-text-muted: #52525b;     /* body */
  --color-text-dim:   #a1a1aa;     /* meta / labels */

  /* Accent (brand green stays for now; can swap to indigo later) */
  --color-brand-50:  #f0fdf4;
  --color-brand-500: #22c55e;
  --color-brand-600: #16a34a;
  --color-brand-700: #15803d;

  /* Sidebar — kept dark for contrast against the white main area, Linear-style */
  --color-sidebar-bg:       #18181b;
  --color-sidebar-text:     #d4d4d8;
  --color-sidebar-text-mid: #71717a;
  --color-sidebar-hover:    #27272a;
  --color-sidebar-active:   #3f3f46;

  /* Recording */
  --color-recording: #ef4444;

  /* Typography */
  --font-display: 'Inter', -apple-system, 'SF Pro Text', system-ui, sans-serif;
}
```

### Component primitives

- **`Button`** — three variants (`primary` brand-green, `secondary` zinc, `ghost` text-only), three sizes (`sm`, `md`, `lg`), loading + disabled states
- **`Card`** — `bg-white border border-zinc-200 rounded-lg p-5 shadow-sm`. Optional header / footer slots
- **`Input`** — `bg-white border-zinc-300 focus:ring-brand-500/30`
- **`Badge`** — small pill, three colors (neutral, success green, danger red)
- **`Empty`** — icon (Lucide) + headline + helper + optional CTA. Replaces the bare "No meetings yet." paragraphs

### Iconography

Replace every unicode glyph with a Lucide icon. Map:
- `●` (Start meeting) → `Circle` filled, `<Mic />` for nav
- `◼` (Stop meeting) → `Square` filled
- Home `◉` → `<Home />`
- Knowledge `▤` → `<BookOpen />`
- Memory `✦` → `<Sparkles />`
- Tasks `□` → `<CheckSquare />`
- Settings `⚙` → `<Settings />`
- Live meeting `●` → `<Radio />` when idle, animated when recording

## Global meeting store

`desktop/src/stores/meetingStore.ts`:

```ts
import { create } from 'zustand';
import type { TranscriptSegment } from '@/lib/tauri';
import type { Meeting, SourceCitation } from '@/lib/backend';

interface MeetingState {
  meeting: Meeting | null;
  running: boolean;
  startedAt: number | null;       // Date.now() at start, for elapsed display
  segments: Array<TranscriptSegment & { meetingId: string }>;
  ask: {
    asking: boolean;
    question: string;
    answer: string;
    sources: SourceCitation[];
    error: string | null;
  };
  // actions
  setMeeting: (m: Meeting | null) => void;
  setRunning: (b: boolean) => void;
  appendSegment: (s: TranscriptSegment, meetingId: string) => void;
  resetAsk: () => void;
  setAsking: (b: boolean) => void;
  appendAnswerToken: (t: string) => void;
  setSources: (s: SourceCitation[]) => void;
  setQuestion: (q: string) => void;
  reset: () => void;
}
```

The store exposes:
- `useMeeting()` — returns `meeting`
- `useRunning()` — returns `running`
- `useSegments()` — returns the array (with `useShallow` to avoid re-renders for unchanged refs)
- `useElapsed()` — derived from `startedAt`, ticks every second via a single shared interval set up in `__root.tsx`

### One-time global subscription

In `__root.tsx`'s `RootLayout`, on mount:

```ts
useEffect(() => {
  let unlisten: (() => void) | null = null;
  onTranscriptUpdate((seg) => {
    const meetingId = useMeetingStore.getState().meeting?.id;
    if (!meetingId) return;
    useMeetingStore.getState().appendSegment(seg, meetingId);
    void appendTranscripts(meetingId, [...]).catch(() => undefined);
  }).then((fn) => { unlisten = fn; });
  return () => { unlisten?.(); };
}, []);
```

This is the key fix — the subscription is set up once, lives in the React tree above all routes, and the store fans out to whichever screen is mounted.

### `meetingLifecycle.ts`

`startMeeting()` and `stopMeeting()` extracted from the component:

```ts
export async function startMeeting() {
  const store = useMeetingStore.getState();
  store.reset();
  const m = await createMeeting({});
  store.setMeeting(m);
  await micStart();
  try {
    await Promise.race([systemAudioStart(), timeout(4000)]);
  } catch { /* mic-only ok */ }
  await mixerStart();
  try { await asrStart('small.en'); } catch { await asrStart('tiny.en'); }
  store.setRunning(true);
}

export async function stopMeeting() {
  const store = useMeetingStore.getState();
  store.setRunning(false);
  await asrStop();
  await mixerStop();
  await systemAudioStop().catch(() => undefined);
  await micStop();
  const m = store.meeting;
  if (m) {
    await patchMeeting(m.id, { status: 'completed', ended_at: new Date().toISOString() });
  }
}
```

The meeting screen's Start/Stop buttons just call these. The sidebar `RecordingBadge` also exposes a Stop button that calls `stopMeeting()`.

## Screen redesigns

### `__root.tsx` (shell)

Layout (mac-window style):
```
┌──────────────────────────────────────────────────────────┐
│  ┌──────┐  ┌──────────────────────────────────────────┐  │
│  │ Side │  │                                          │  │
│  │ Nav  │  │   Content area (cards on #fafafa)       │  │
│  │      │  │                                          │  │
│  │ ◉ Home│  │                                          │  │
│  │ ● Live│  │                                          │  │
│  │ 📖 KB │  │                                          │  │
│  │ ✨ Mem│  │                                          │  │
│  │ ☐ Task│  │                                          │  │
│  │ ⚙ Set │  │                                          │  │
│  │      │  │                                          │  │
│  │      │  │                                          │  │
│  │ ┌──┐ │  │                                          │  │
│  │ │REC│ │  │                                          │  │
│  │ └──┘ │  │                                          │  │
│  └──────┘  └──────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- Sidebar 200px wide on a `bg-zinc-950` background (or `--color-sidebar-bg`)
- Main area `bg-zinc-50` (`#fafafa`)
- Window draggable region via `data-tauri-drag-region` on the top strip
- RecordingBadge pinned to bottom of sidebar (only when running)

### `SideNav.tsx`

- Logo + product name at top (Meetwit wordmark in `text-zinc-200`)
- Nav items: icon (16px Lucide) + label, active = `bg-zinc-800 text-white`, inactive = `text-zinc-400 hover:text-zinc-200`
- "Start meeting" CTA button between nav and bottom badge (always visible, primary brand green) — clicking jumps to `/meeting/live` AND auto-starts the meeting
- `RecordingBadge` at the bottom when `running === true`

### `RecordingBadge.tsx`

- Pulsing red dot + "Recording 02:14" elapsed timer + small ◼ stop button
- Click anywhere on the badge body navigates to `/meeting/live`
- Always rendered when `running === true`, regardless of current route
- Style: dark card on the dark sidebar, red dot does CSS animation

### `index.tsx` (Home)

Hero-style. Three vertical sections:

1. **Hero CTA** (Card) — large, single primary button "Start a new meeting" with mic icon. Subtitle: "Records mic + system audio, transcribes locally, answers questions from your docs."
2. **Stats grid** — four small cards: Indexed docs, Chunks, Meetings, Open tasks. Icons from Lucide. Click → drills into the relevant page.
3. **Recent meetings** — table or compact list with title, started_at, transcript count, status badge. Click row → `/meeting/$id/summary`. Empty state uses `<Empty>` component with `<Mic />` icon + "Start your first meeting" CTA.

### `meeting.live.tsx` (the central one)

Top bar (sticky, white, `border-b`):
- Meeting title (editable inline — click to rename)
- Project tag (chip)
- Elapsed timer (mono font)
- Status: `<Badge color="recording">● Recording</Badge>` with pulsing dot
- Primary action button: `Start` (green) or `Stop` (red)

Two-pane body:

**Left — Transcript** (60% width):
- Full-bleed white card
- Each segment: timestamp chip + speaker label (if present) + text. Generous line-height
- Between latest segment and bottom: `<Listening />` animated dots when `running && segments.length last < now - 2s`
- Auto-scroll to bottom on each new segment (smooth scroll, `behavior: 'smooth'`)
- Empty state with `<Empty>` showing waveform icon + "Listening for speech…"

**Right — Q&A panel** (40% width, ~480px):
- Question input pinned to top (white card, multi-line auto-grow)
- Answer area below: streaming token text in a white card. When `answer === ''` and `asking`, show a subtle skeleton
- Sources list below: real Card per source, with `[1]` badge, doc filename, page, snippet (line-clamp-3). Click → opens preview drawer (V1.1; for now just shows full text in a modal)
- Empty state: `<Empty>` with `<Sparkles />` + "Ask anything about this meeting"

### `meeting.$id.summary.tsx`

Same top bar shell as live (title, badge showing "Completed", elapsed). Tabbed content:
- **Overview** — Card with overview paragraph, Key Points bulleted, Recommended Next Steps. "Re-run" button at top right.
- **Decisions** — list of Cards (one per decision)
- **Actions** — table with checkbox + task + owner + deadline + status. Inline editable status (open/done toggle).
- **Conflicts** — empty state in green "No conflicts" if list is empty; otherwise list of red-tinted Cards.
- **Transcript** — same renderer as the live transcript but read-only.

### `knowledge.tsx`

- Hero card: "Index a folder" with a folder picker input + Index button
- Stats grid below (Documents, Chunks, Last indexed)
- Document list as a striped table: filename (truncated middle), type, chunks, status badge, indexed_at. Hover row → reveal Delete icon button.

### `memory.tsx`

ChatGPT-style:
- Centered max-w-3xl
- Empty state with `<Empty>` showing example questions as clickable chips ("What's our refund policy?", "Who owns Globex?", etc.)
- Question input pinned to bottom (multi-line auto-grow, Cmd+Enter to submit)
- Answer streams above input. Sources after answer.

### `tasks.tsx`

Already simple — just restyle. Cards instead of inline borders. Checkboxes with custom design. Filter tabs at top.

### `settings.tsx`

Card per section (matching Meetily's "card per group" layout):
- **General** — theme, notifications (toggle)
- **Audio** — input device dropdown (placeholder, V1.1 wires actual list), VAD threshold slider (dev-only, hidden behind a toggle)
- **AI** — Ollama status + model picker, Whisper model picker with sizes + download buttons
- **Knowledge** — folder picker, embedding model (read-only display)
- **Privacy** — open data folder, export all data, danger zone (clear meetings, clear knowledge, reset Meetwit) with red destructive buttons

### `onboarding.tsx`

Restyle the 6-step wizard. Each step in a centered Card with:
- Step indicator at top (current/total)
- Icon + headline
- Body copy
- Primary CTA + secondary "back"
- Progress bar at the very top of the viewport

## "Listening…" animation

`Listening.tsx`:

```tsx
export function Listening() {
  return (
    <div className="flex items-center gap-1.5 py-2 text-zinc-500">
      <span className="text-sm">Listening</span>
      <span className="flex gap-0.5">
        <span className="h-1 w-1 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.3s]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-zinc-400 [animation-delay:-0.15s]" />
        <span className="h-1 w-1 animate-bounce rounded-full bg-zinc-400" />
      </span>
    </div>
  );
}
```

Three bouncing dots, classic typing-indicator pattern. Shown beneath the last transcript segment whenever `running === true` and either (a) no segments yet or (b) it's been >2s since the last segment.

## Implementation order

To minimize churn and keep CI green throughout:

1. **Add the dep + design tokens** (`lucide-react` already in package.json; just update styles.css + body class).
2. **Build the primitive components** — `Button`, `Card`, `Input`, `Badge`, `Empty`, `Listening`. Each in isolation, ~30 lines each.
3. **Create the meeting store + lifecycle module**. Doesn't change UI yet — just sets up the architecture.
4. **Lift global subscription into `__root.tsx`**. Test that recordings now persist across navigation (transcript appears even if you navigate away and back).
5. **Build `RecordingBadge`** and wire it into the sidebar layout.
6. **Restyle `SideNav.tsx`** — light layout with Lucide icons.
7. **Rebuild `meeting.live.tsx`** to read from store + use new primitives + Listening animation + auto-scroll.
8. **Restyle remaining screens** in any order: Home → Summary → Knowledge → Memory → Tasks → Settings → Onboarding.
9. **Final pass**: typography, hover states, focus rings, keyboard shortcuts (Cmd+N to start meeting, Cmd+K to focus memory search).
10. **Verification** (see below).

## Verification

Frontend:
```bash
pnpm -F meetwit-desktop typecheck   # TS strict + exactOptionalPropertyTypes
pnpm -F meetwit-desktop lint         # ESLint 0 warnings
pnpm -F meetwit-desktop build        # Vite build
```

Rust:
```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Manual interactive (the actual UX validation):
1. `pnpm tauri:dev` — window opens with the new white theme.
2. **State persistence test**: Click Start meeting → speak 10s → see first transcript. Navigate to Knowledge tab. Speak more. Return to `/meeting/live`. **All transcripts including the new ones are present.** Sidebar shows "Recording 00:34" badge throughout.
3. **Listening animation test**: Start meeting, stay silent. Beneath the empty transcript, the "Listening…" animation pulses.
4. **Theme test**: Every route has a white background, dark sidebar, no leftover dark cards.
5. **Icon test**: No unicode glyphs anywhere — only Lucide SVGs.
6. **Empty states**: Wipe the data folder, open Home — sees friendly empty state with `<Mic />` icon + "Start your first meeting" CTA.
7. **Q&A test**: With sample-docs indexed, ask "What's our refund window?" — sources appear immediately, answer streams in. Sources card is properly styled.

## Risk / open items

- **Color of accent**: keeping brand green for now. If after seeing it side-by-side you want indigo/blue (more "professional"), it's a one-line change in `styles.css`.
- **`text-zinc-` vs `text-neutral-`**: Tailwind 4 has both; we'll standardize on `zinc` (slightly cooler) per Linear's convention.
- **Window chrome (titlebar)**: Currently Tauri's overlay title bar. May want hidden title + traffic-light position adjusted to match Linear's "embedded traffic lights" look. Out of scope for this pass — note as V1.1.
- **Real speaker diarization**: still V1.1 (pyannote.audio in Python sidecar).
- **Inline rename of meeting title**: included in this pass (click title → contenteditable input).

## Out of scope

- Auto-update flow (V1.1, requires Apple Developer enrollment first)
- Cloud LLM toggle in Settings (V1.1)
- Pyannote diarization (V1.1)
- Streaming partial transcripts (deferred — adds complexity for marginal UX gain over the listening animation)
- Tray/menubar indicator (post-V1, requires Tauri tray API + macOS dock icon work)
- Window decoration polish (post-V1)

## Where this plan lives (housekeeping)

After approval, I'll also copy this plan into the repo at `docs/UX_OVERHAUL.md` so it lives next to the code and can be tracked alongside CHANGELOG.md and ROADMAP.md.
