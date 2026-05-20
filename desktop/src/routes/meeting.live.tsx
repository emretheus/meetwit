import { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  appendTranscripts,
  createMeeting,
  liveAsk,
  patchMeeting,
  type Meeting,
  type SourceCitation,
} from '@/lib/backend';
import {
  asrStart,
  asrStop,
  micStart,
  micStop,
  mixerStart,
  mixerStop,
  onTranscriptUpdate,
  systemAudioStart,
  systemAudioStop,
  type TranscriptSegment,
} from '@/lib/tauri';

export const Route = createFileRoute('/meeting/live')({
  component: LiveMeeting,
});

interface UiSegment extends TranscriptSegment {
  meetingId: string;
}

function LiveMeeting() {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [running, setRunning] = useState(false);
  const [segments, setSegments] = useState<UiSegment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [answerTokens, setAnswerTokens] = useState<string[]>([]);
  const [sources, setSources] = useState<SourceCitation[]>([]);
  const [asking, setAsking] = useState(false);

  const unlistenRef = useRef<(() => void) | null>(null);

  async function handleStart() {
    setError(null);
    try {
      const m = await createMeeting({});
      setMeeting(m);

      // Audio + mixer + ASR
      await micStart();

      // System audio is optional — if it hangs (user hasn't granted Screen
      // Recording yet, no dialog dismissed, etc.) we don't want to block
      // the rest of the meeting flow. Race against a 4-second timeout.
      try {
        await Promise.race([
          systemAudioStart(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('system-audio timeout')), 4000),
          ),
        ]);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('System audio unavailable — continuing with mic only:', err);
      }

      await mixerStart();
      await asrStart('tiny.en');

      const unlisten = await onTranscriptUpdate((seg) => {
        setSegments((s) => [...s, { ...seg, meetingId: m.id }]);
        const payload: {
          text: string;
          audio_start: number;
          audio_end: number;
          speaker?: string;
        } = {
          text: seg.text,
          audio_start: seg.audio_start,
          audio_end: seg.audio_end,
        };
        if (seg.speaker !== null) payload.speaker = seg.speaker;
        void appendTranscripts(m.id, [payload]).catch(() => undefined);
      });
      unlistenRef.current = unlisten;
      setRunning(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop() {
    setRunning(false);
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    try {
      await asrStop();
      await mixerStop();
      await systemAudioStop().catch(() => undefined);
      await micStop();
      if (meeting) {
        await patchMeeting(meeting.id, {
          status: 'completed',
          ended_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  async function handleAsk() {
    if (!meeting || !question.trim() || asking) return;
    setAsking(true);
    setAnswerTokens([]);
    setSources([]);
    try {
      await liveAsk(
        { meeting_id: meeting.id, question },
        {
          onSources: setSources,
          onToken: (t) => setAnswerTokens((prev) => [...prev, t]),
          onError: (msg) => setError(msg),
        },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAsking(false);
    }
  }

  const answer = answerTokens.join('');

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <header className="border-b border-neutral-800 px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-medium">
              {meeting ? meeting.title ?? 'Untitled meeting' : 'Start a meeting'}
            </h1>
            <p className="text-xs text-neutral-500">
              {meeting ? `id ${meeting.id.slice(0, 8)}…` : '— no active meeting —'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <button
                type="button"
                onClick={handleStop}
                className="rounded-md border border-red-700 bg-red-900/30 px-3 py-1.5 text-sm text-red-200 hover:bg-red-900/50"
              >
                ◼ Stop meeting
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStart}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-500"
              >
                ● Start meeting
              </button>
            )}
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-red-400">✗ {error}</p>}
      </header>

      {/* Two-pane body */}
      <div className="flex flex-1 min-h-0">
        {/* Live transcript */}
        <div className="flex-1 min-w-0 overflow-y-auto px-6 py-4">
          <h2 className="text-xs uppercase tracking-wider text-neutral-500">Live transcript</h2>
          {segments.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">
              {running ? 'Listening…' : 'Click "Start meeting" to begin.'}
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {segments.map((s, i) => (
                <li key={i} className="text-sm leading-relaxed">
                  <span className="mr-2 font-mono text-xs text-neutral-500">
                    {formatTime(s.audio_start)}
                  </span>
                  {s.text}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Q&A panel */}
        <aside className="flex w-[420px] flex-col border-l border-neutral-800">
          <div className="border-b border-neutral-800 px-4 py-3">
            <h2 className="text-xs uppercase tracking-wider text-neutral-500">Ask the meeting</h2>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={!meeting || asking}
                placeholder={meeting ? 'Ask about decisions, docs, …' : 'Start a meeting first'}
                className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm placeholder-neutral-600 focus:border-brand-600 focus:outline-none disabled:opacity-50"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAsk();
                }}
              />
              <button
                type="button"
                disabled={!meeting || asking || !question.trim()}
                onClick={() => void handleAsk()}
                className="rounded-md bg-brand-600 px-2 py-1 text-xs text-white disabled:opacity-50"
              >
                {asking ? '…' : 'Ask'}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3">
            {answer && (
              <div className="mb-4 rounded-md bg-neutral-900 p-3 text-sm whitespace-pre-wrap leading-relaxed">
                {answer}
              </div>
            )}

            {sources.length > 0 && (
              <div>
                <h3 className="text-xs uppercase tracking-wider text-neutral-500">Sources</h3>
                <ul className="mt-2 space-y-2">
                  {sources.map((s) => (
                    <li key={s.label} className="rounded border border-neutral-800 p-2 text-xs">
                      <div className="font-medium text-neutral-200">
                        [{s.label}] {s.document_path.split('/').pop()}
                        {s.page_number !== null && ` · p.${s.page_number}`}
                        {s.section_title && ` · ${s.section_title}`}
                      </div>
                      <p className="mt-1 line-clamp-3 text-neutral-400">{s.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
