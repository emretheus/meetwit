import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { TranscriptSegment } from '@/lib/tauri';
import type { Insight, Meeting, SourceCitation } from '@/lib/backend';

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

/**
 * One proactive-watcher insight, plus client-side display state.
 *
 * `id` is a deterministic hash of timestamp+headline so the same insight
 * arriving twice from successive scans collapses into one row.
 */
export interface StoredInsight extends Insight {
  id: string;
  receivedAt: number;
  acknowledged: boolean;
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

  insights: StoredInsight[];
  /** High-water mark in audio seconds that the proactive watcher has scanned up to. */
  insightsScannedThrough: number;

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

  // Insights actions
  addInsights: (items: Insight[], scannedThrough: number) => void;
  acknowledgeInsight: (id: string) => void;
  acknowledgeAllInsights: () => void;
  dismissInsight: (id: string) => void;

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

function insightId(item: Insight): string {
  // Same headline + same timestamp = same insight. Successive scans often
  // re-flag the same moment, especially while the model is on the same chunk.
  const stamp = Math.round(item.evidence_timestamp_seconds * 10) / 10;
  return `${stamp}-${item.headline.slice(0, 60)}`;
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
  insights: [],
  insightsScannedThrough: 0,

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
        turns: s.ask.turns.map((turn) =>
          turn.id === turnId ? { ...turn, sources } : turn,
        ),
      },
    })),

  finishAssistantTurn: (turnId, error = null) =>
    set((s) => ({
      ask: {
        ...s.ask,
        asking: false,
        error,
        turns: s.ask.turns.map((turn) =>
          turn.id === turnId
            ? { ...turn, streaming: false, error: error ?? null }
            : turn,
        ),
      },
    })),

  resetAsk: () => set({ ask: emptyAsk }),

  addInsights: (items, scannedThrough) =>
    set((s) => {
      const byId = new Map(s.insights.map((i) => [i.id, i]));
      for (const item of items) {
        const id = insightId(item);
        if (byId.has(id)) continue; // dedupe — same insight, already shown
        byId.set(id, {
          ...item,
          id,
          receivedAt: Date.now(),
          acknowledged: false,
        });
      }
      return {
        insights: Array.from(byId.values()).sort(
          (a, b) => a.evidence_timestamp_seconds - b.evidence_timestamp_seconds,
        ),
        insightsScannedThrough: Math.max(s.insightsScannedThrough, scannedThrough),
      };
    }),

  acknowledgeInsight: (id) =>
    set((s) => ({
      insights: s.insights.map((i) => (i.id === id ? { ...i, acknowledged: true } : i)),
    })),

  acknowledgeAllInsights: () =>
    set((s) => ({
      insights: s.insights.map((i) => ({ ...i, acknowledged: true })),
    })),

  dismissInsight: (id) =>
    set((s) => ({
      insights: s.insights.filter((i) => i.id !== id),
    })),

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
      insights: [],
      insightsScannedThrough: 0,
    }),
}));

// ─── Selectors ─────────────────────────────────────────────────────────

export const useMeeting = (): Meeting | null => useMeetingStore((s) => s.meeting);
export const useRunning = (): boolean => useMeetingStore((s) => s.running);
export const usePaused = (): boolean => useMeetingStore((s) => s.paused);
export const useStartedAt = (): number | null => useMeetingStore((s) => s.startedAt);
export const useSegments = (): UiSegment[] =>
  useMeetingStore(useShallow((s) => s.segments));
export const useLastSegmentAt = (): number | null =>
  useMeetingStore((s) => s.lastSegmentAt);
export const useAsk = (): AskState => useMeetingStore(useShallow((s) => s.ask));
export const useInsights = (): StoredInsight[] =>
  useMeetingStore(useShallow((s) => s.insights));
export const useInsightsScannedThrough = (): number =>
  useMeetingStore((s) => s.insightsScannedThrough);
export const useUnreadInsightCount = (): number =>
  useMeetingStore((s) => s.insights.filter((i) => !i.acknowledged).length);
