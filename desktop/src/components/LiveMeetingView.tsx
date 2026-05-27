import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AlertCircle,
  ArrowLeft,
  CalendarDays,
  Copy,
  ExternalLink,
  Mic,
  MoreHorizontal,
  Pause,
  Play,
  Square,
  Wand2,
} from 'lucide-react';
import { patchMeeting } from '@/lib/backend';
import { pauseMeeting, resumeMeeting, startMeeting, stopMeeting } from '@/lib/meetingLifecycle';
import {
  useLastSegmentAt,
  useMeeting,
  useMeetingStore,
  usePaused,
  useRunning,
  useSegments,
  useStartedAt,
} from '@/stores/meetingStore';
import {
  Badge,
  Empty,
  Listening,
  Toolbar,
  ToolbarButton,
  ToolbarDivider,
  ToolbarSpacer,
} from '@/components/ui';
import { MeetingCopilot } from '@/components/MeetingCopilot';
import { LiveNotesPanel } from '@/components/LiveNotesPanel';
import { ClaudeTerminalSlot } from '@/components/ClaudeTerminalHost';
import { toast } from '@/components/ToastStack';
import { getPrefs } from '@/lib/prefs';
import { formatTime, groupSegmentsIntoTurns } from '@/lib/transcript';

function formatElapsed(ms: number | null): string {
  if (ms === null) return '00:00';
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

interface LiveMeetingViewProps {
  /** Show a "back to home" arrow in the top bar (true on /meeting/live, false on Home). */
  showBack?: boolean;
}

/**
 * The live recording surface — transcript on the left, Copilot on the right,
 * record/pause/stop toolbar. Hosted both by Home (record-in-place) and the
 * /meeting/live route. State is global (Zustand), so it survives navigation
 * between the two.
 */
export function LiveMeetingView({ showBack = false }: LiveMeetingViewProps) {
  const meeting = useMeeting();
  const running = useRunning();
  const paused = usePaused();
  const segments = useSegments();
  const startedAt = useStartedAt();
  const lastSegmentAt = useLastSegmentAt();
  const error = useMeetingStore((s) => s.error);
  const setError = useMeetingStore((s) => s.setError);

  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showCompliance, setShowCompliance] = useState(false);
  const [rightTab, setRightTab] = useState<'copilot' | 'notes' | 'claude'>('copilot');
  // Opt-in "Claude Code" tab (read once; Settings change takes effect on reopen).
  const [claudeCodeEnabled] = useState(() => getPrefs().claudeCodeEnabled);
  // The terminal itself lives app-level (ClaudeTerminalHost) so it survives route
  // changes; here we just tell the store when the Claude tab is the active view,
  // and host a slot the shared terminal node is re-parented into.
  const setClaudeTabActive = useMeetingStore((s) => s.setClaudeTabActive);
  useEffect(() => {
    setClaudeTabActive(rightTab === 'claude');
  }, [rightTab, setClaudeTabActive]);
  // When this view unmounts (route change), don't leave the tab "active".
  useEffect(() => () => setClaudeTabActive(false), [setClaudeTabActive]);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const prevRunningRef = useRef(running);
  useEffect(() => {
    if (prevRunningRef.current !== running) {
      if (running && getPrefs().startNotification) {
        setShowCompliance(true);
        window.setTimeout(() => setShowCompliance(false), 5000);
      }
      if (!running) setShowCompliance(false);
      prevRunningRef.current = running;
    }
  }, [running]);

  // On each new segment, scroll the transcript container all the way to the
  // bottom. We scroll the container itself (not scrollIntoView) so the pb-28
  // breathing room stays below the last line — keeping it clear of the
  // floating record pill while the newest text stays in focus.
  useEffect(() => {
    const el = transcriptScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [segments.length]);

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await startMeeting();
    } catch {
      /* error already in store */
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      await stopMeeting();
    } finally {
      setStopping(false);
    }
  }

  async function copyTranscript() {
    if (segments.length === 0) {
      toast({ title: 'Nothing to copy', tone: 'info', durationMs: 2000 });
      return;
    }
    const text = groupSegmentsIntoTurns(segments)
      .map((t) => `[${formatTime(t.start)}] ${t.text}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Transcript copied', tone: 'success', durationMs: 2500 });
    } catch {
      toast({ title: "Couldn't copy", tone: 'error' });
    }
  }

  async function commitTitle() {
    if (titleDraft === null || !meeting) return;
    const next = titleDraft.trim();
    setTitleDraft(null);
    if (next === (meeting.title ?? '')) return;
    try {
      const updated = await patchMeeting(meeting.id, { title: next || null });
      useMeetingStore.getState().setMeeting(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const elapsedMs = startedAt ? nowTick - startedAt : null;
  const showListening =
    running &&
    (segments.length === 0 || (lastSegmentAt !== null && nowTick - lastSegmentAt > 2000));

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Top bar */}
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-zinc-200 bg-white/90 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {showBack && (
            <Link
              to="/"
              className="-ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
              title="Back to home"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </Link>
          )}
          {titleDraft !== null ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void commitTitle();
                if (e.key === 'Escape') setTitleDraft(null);
              }}
              className="border-brand-400 focus:ring-brand-100 min-w-0 flex-1 rounded-md border bg-white px-2 py-1 text-[15px] font-semibold tracking-tight text-zinc-900 focus:outline-none focus:ring-2"
              placeholder="Untitled meeting"
            />
          ) : (
            <button
              type="button"
              onClick={() => meeting && setTitleDraft(meeting.title ?? '')}
              disabled={!meeting}
              className="hover:text-brand-700 truncate text-[15px] font-semibold tracking-tight text-zinc-900 transition disabled:cursor-default disabled:text-zinc-400"
              title={meeting ? 'Click to rename' : 'Start a meeting to enable rename'}
            >
              {meeting ? (meeting.title ?? 'Untitled meeting') : 'New recording'}
            </button>
          )}
          {meeting?.project && (
            <Badge color="info" size="xs">
              {meeting.project}
            </Badge>
          )}
          {meeting?.calendar_event_id && (
            <Badge color="info" size="xs" icon={<CalendarDays className="h-3 w-3" />}>
              From calendar
            </Badge>
          )}
          {running && paused && (
            <Badge color="warning" dot size="xs">
              Paused
            </Badge>
          )}
          {running && !paused && (
            <Badge color="recording" dot size="xs">
              Recording
            </Badge>
          )}
          {meeting && !running && (
            <Badge color="neutral" size="xs">
              Stopped
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {running && (
            <span className="font-mono text-[13px] font-medium tabular-nums text-zinc-700">
              {formatElapsed(elapsedMs)}
            </span>
          )}
          {meeting && !running && (
            <Link
              to="/meeting/$id/summary"
              params={{ id: meeting.id }}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2 text-[12px] font-medium text-zinc-700 transition hover:bg-zinc-50 hover:text-zinc-900"
            >
              <ExternalLink className="h-3 w-3" />
              Open summary
            </Link>
          )}
          <button
            type="button"
            title="More"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 border-b border-red-200 bg-red-50/80 px-6 py-2 text-[12px] text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {showCompliance && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50/80 px-6 py-2 text-[12px] text-amber-900">
          <span className="flex items-center gap-2">
            <span className="recording-dot inline-block h-2 w-2 rounded-full bg-orange-500" />
            Meetwit is recording. Please inform your participants.
          </span>
          <button
            type="button"
            onClick={() => setShowCompliance(false)}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-700 hover:bg-amber-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Two-pane body */}
      <div className="flex min-h-0 flex-1">
        {/* Transcript */}
        <section className="flex min-w-0 flex-1 flex-col bg-white">
          <Toolbar bordered>
            <ToolbarButton
              icon={<Copy className="h-3.5 w-3.5" />}
              label="Copy"
              onClick={() => void copyTranscript()}
              disabled={segments.length === 0}
            />
            <ToolbarDivider />
            {running ? (
              <>
                <ToolbarButton
                  icon={
                    paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />
                  }
                  label={paused ? 'Resume' : 'Pause'}
                  onClick={() => void (paused ? resumeMeeting() : pauseMeeting())}
                />
                <ToolbarButton
                  icon={<Square className="h-3.5 w-3.5 fill-current" />}
                  label={stopping ? 'Stopping…' : 'Stop'}
                  tone="danger"
                  active
                  loading={stopping}
                  onClick={() => void handleStop()}
                />
              </>
            ) : (
              <ToolbarButton
                icon={<Mic className="h-3.5 w-3.5" />}
                label={starting ? 'Starting…' : 'Record'}
                tone="brand"
                active
                loading={starting}
                onClick={() => void handleStart()}
              />
            )}
            <ToolbarButton
              icon={<Wand2 className="h-3.5 w-3.5" />}
              label="Enhance"
              disabled={segments.length === 0}
              title="Clean filler words · Retranscribe (coming soon)"
            />
            <ToolbarSpacer />
            <span className="px-1 text-[11px] tabular-nums text-zinc-400">
              {segments.length} segment{segments.length === 1 ? '' : 's'}
            </span>
          </Toolbar>

          <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto px-7 pb-28 pt-6">
            {segments.length === 0 && !running ? (
              <Empty
                icon={<Mic className="h-5 w-5" />}
                title="No transcript yet"
                description="Click Record to begin capturing mic + system audio. Everything stays on this Mac."
              />
            ) : (
              <ul className="space-y-5">
                {groupSegmentsIntoTurns(segments).map((turn, i) => (
                  <li
                    key={`${turn.start}-${i}`}
                    className="flex gap-3 text-[14px] leading-[1.65] text-zinc-800"
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(
                            `[${formatTime(turn.start)}] ${turn.text}`,
                          );
                          toast({ title: 'Line copied', tone: 'success', durationMs: 1800 });
                        } catch {
                          /* ignore */
                        }
                      }}
                      title="Copy line"
                      className="hover:bg-brand-50 hover:text-brand-700 hover:ring-brand-200 mt-1 inline-flex h-5 shrink-0 items-center rounded-md bg-white px-1.5 font-mono text-[10px] tabular-nums text-zinc-500 ring-1 ring-inset ring-zinc-200 transition"
                    >
                      {formatTime(turn.start)}
                    </button>
                    <span className="min-w-0 flex-1">{turn.text}</span>
                  </li>
                ))}
                {showListening && (
                  <li className="pl-12 pt-1">
                    <Listening />
                  </li>
                )}
              </ul>
            )}
          </div>
        </section>

        {/* Right pane: live Copilot + manual Notes (#389). The full summary
            lives on the note page; during recording these are the live value. */}
        <aside className="flex w-[440px] shrink-0 flex-col border-l border-zinc-200 bg-white">
          <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 px-3 py-1.5">
            {(
              ['copilot', 'notes', ...(claudeCodeEnabled ? (['claude'] as const) : [])] as const
            ).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setRightTab(t)}
                className={[
                  'rounded-md px-2.5 py-1 text-[12px] font-medium transition',
                  rightTab === t
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700',
                ].join(' ')}
              >
                {t === 'copilot' ? 'Copilot' : t === 'notes' ? 'Notes' : 'Claude Code'}
              </button>
            ))}
          </div>
          {rightTab === 'copilot' && <MeetingCopilot meetingId={meeting?.id ?? null} withToolbar />}
          {rightTab === 'notes' && (
            <LiveNotesPanel
              meetingId={meeting?.id ?? null}
              elapsedSeconds={elapsedMs !== null ? elapsedMs / 1000 : null}
            />
          )}
          {/* The terminal node is app-level (ClaudeTerminalHost) and gets
              re-parented into this slot while the tab is active — so the live
              `claude` session survives tab AND route changes. */}
          {claudeCodeEnabled && rightTab === 'claude' && <ClaudeTerminalSlot />}
        </aside>
      </div>
    </div>
  );
}
