import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { TranscriptSegment } from '@/lib/tauri';
import type { Meeting, SourceCitation } from '@/lib/backend';

export interface UiSegment extends TranscriptSegment {
  meetingId: string;
  receivedAt: number;
}

/**
 * One turn in the Ask-the-meeting chat. `streaming` is true on the assistant
 * turn that's currently receiving SSE tokens; the UI uses it to render a
 * "thinking" cursor and disable the input.
 */
export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: SourceCitation[];
  streaming?: boolean;
  error?: string | null;
  createdAt: number;
}

interface AskState {
  /** Pending text in the composer. Not part of the chat history yet. */
  draft: string;
  /** Persistent multi-turn conversation for the active meeting. */
  turns: ChatTurn[];
  /** True while an assistant turn is streaming — used to disable the input. */
  asking: boolean;
  /** Banner-level error for the chat panel. */
  error: string | null;
}

interface MeetingState {
  meeting: Meeting | null;
  running: boolean;
  /** True while the recording is paused: audio capture stays alive but ASR is
   *  stopped so no new transcripts arrive, and the elapsed timer freezes. */
  paused: boolean;
  startedAt: number | null;
  segments: UiSegment[];
  lastSegmentAt: number | null;
  error: string | null;
  ask: AskState;

  // Embedded "Claude Code" terminal — app-level so the live `claude` session
  // survives tab AND route changes (the terminal DOM node is re-parented, never
  // re-created; see ClaudeTerminalHost).
  /** Lazily true once the Claude tab is first opened (gates PTY spawn). */
  claudeEverOpened: boolean;
  /** True while the right-panel Claude tab is the active view. */
  claudeTabActive: boolean;
  setClaudeTabActive: (active: boolean) => void;

  setMeeting: (m: Meeting | null) => void;
  setRunning: (b: boolean) => void;
  setPaused: (b: boolean) => void;
  appendSegment: (s: TranscriptSegment, meetingId: string) => void;
  setError: (e: string | null) => void;

  // Ask chat actions
  setDraft: (q: string) => void;
  beginAskExchange: (question: string) => string; // returns assistant turn id
  appendAssistantToken: (turnId: string, t: string) => void;
  setAssistantSources: (turnId: string, sources: SourceCitation[]) => void;
  finishAssistantTurn: (turnId: string, error?: string | null) => void;
  resetAsk: () => void;

  reset: () => void;
}

const emptyAsk: AskState = {
  draft: '',
  turns: [],
  asking: false,
  error: null,
};

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useMeetingStore = create<MeetingState>((set) => ({
  meeting: null,
  running: false,
  paused: false,
  startedAt: null,
  segments: [],
  lastSegmentAt: null,
  error: null,
  ask: emptyAsk,
  claudeEverOpened: false,
  claudeTabActive: false,

  setClaudeTabActive: (active) =>
    set((s) => ({
      claudeTabActive: active,
      claudeEverOpened: s.claudeEverOpened || active,
    })),

  setMeeting: (meeting) => set({ meeting }),
  setRunning: (running) =>
    set((s) => ({
      running,
      startedAt: running ? (s.startedAt ?? Date.now()) : s.startedAt,
      paused: running ? s.paused : false,
    })),
  setPaused: (paused) => set({ paused }),
  appendSegment: (seg, meetingId) =>
    set((s) => ({
      segments: [...s.segments, { ...seg, meetingId, receivedAt: Date.now() }],
      lastSegmentAt: Date.now(),
    })),
  setError: (error) => set({ error }),

  setDraft: (draft) => set((s) => ({ ask: { ...s.ask, draft } })),

  beginAskExchange: (question) => {
    const userTurn: ChatTurn = {
      id: newId(),
      role: 'user',
      content: question,
      createdAt: Date.now(),
    };
    const assistantTurn: ChatTurn = {
      id: newId(),
      role: 'assistant',
      content: '',
      sources: [],
      streaming: true,
      createdAt: Date.now(),
    };
    set((s) => ({
      ask: {
        draft: '',
        turns: [...s.ask.turns, userTurn, assistantTurn],
        asking: true,
        error: null,
      },
    }));
    return assistantTurn.id;
  },

  appendAssistantToken: (turnId, t) =>
    set((s) => ({
      ask: {
        ...s.ask,
        turns: s.ask.turns.map((turn) =>
          turn.id === turnId ? { ...turn, content: turn.content + t } : turn,
        ),
      },
    })),

  setAssistantSources: (turnId, sources) =>
    set((s) => ({
      ask: {
        ...s.ask,
        turns: s.ask.turns.map((turn) => (turn.id === turnId ? { ...turn, sources } : turn)),
      },
    })),

  finishAssistantTurn: (turnId, error = null) =>
    set((s) => ({
      ask: {
        ...s.ask,
        asking: false,
        error,
        turns: s.ask.turns.map((turn) =>
          turn.id === turnId ? { ...turn, streaming: false, error: error ?? null } : turn,
        ),
      },
    })),

  resetAsk: () => set({ ask: emptyAsk }),

  reset: () =>
    set({
      meeting: null,
      running: false,
      paused: false,
      startedAt: null,
      segments: [],
      lastSegmentAt: null,
      error: null,
      ask: emptyAsk,
      // Drop the terminal binding too — a new session gets a fresh `claude`.
      claudeTabActive: false,
      claudeEverOpened: false,
    }),
}));

// ─── Selectors ─────────────────────────────────────────────────────────

export const useMeeting = (): Meeting | null => useMeetingStore((s) => s.meeting);
export const useRunning = (): boolean => useMeetingStore((s) => s.running);
export const usePaused = (): boolean => useMeetingStore((s) => s.paused);
export const useStartedAt = (): number | null => useMeetingStore((s) => s.startedAt);
export const useSegments = (): UiSegment[] => useMeetingStore(useShallow((s) => s.segments));
export const useLastSegmentAt = (): number | null => useMeetingStore((s) => s.lastSegmentAt);
export const useClaudeEverOpened = (): boolean => useMeetingStore((s) => s.claudeEverOpened);
export const useClaudeTabActive = (): boolean => useMeetingStore((s) => s.claudeTabActive);
export const useAsk = (): AskState => useMeetingStore(useShallow((s) => s.ask));
