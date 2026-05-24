import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, Mic } from 'lucide-react';
import { listMeetings, type Meeting } from '@/lib/backend';
import { startMeeting } from '@/lib/meetingLifecycle';
import { useBackendReady } from '@/lib/useBackendReady';
import { useRunning } from '@/stores/meetingStore';
import { Spinner } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { LiveMeetingView } from '@/components/LiveMeetingView';
import { TodayMeetings } from '@/components/TodayMeetings';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [meetingsLoading, setMeetingsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const running = useRunning();
  const { ready: backendReady, error: backendError } = useBackendReady();

  useEffect(() => {
    if (!backendReady) return;
    setMeetingsLoading(true);
    void listMeetings()
      .then(setMeetings)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setMeetingsLoading(false));
  }, [backendReady]);

  const effectiveError = error ?? backendError;

  // Home IS the recording surface (Meetily style): show the live view ONLY
  // while a recording is actually in progress. Once stopped, Home returns to
  // the welcome state — the finished note is opened from the sidebar / the
  // "View Meeting" toast, not left lingering here as a live page.
  if (running) {
    return <LiveMeetingView />;
  }

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    try {
      // Start recording IN PLACE — no navigation. `startMeeting` flips
      // `running`, which re-renders Home into the LiveMeetingView above.
      await startMeeting();
    } catch {
      /* error surfaces via the live view */
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white">
      {/* Soft brand backdrop — a faint radial wash + subtle dot grid so the
          hero doesn't float in a stark white void. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(120% 80% at 50% -10%, rgba(37,99,235,0.06) 0%, rgba(37,99,235,0) 55%)',
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage: 'radial-gradient(rgba(15,23,42,0.05) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage: 'radial-gradient(80% 60% at 50% 40%, #000 0%, transparent 75%)',
          WebkitMaskImage: 'radial-gradient(80% 60% at 50% 40%, #000 0%, transparent 75%)',
        }}
      />

      <div className="relative flex flex-1 items-center justify-center px-10">
        {meetingsLoading ? (
          <div className="flex flex-col items-center gap-3 text-zinc-400">
            <Spinner size={20} tone="text-zinc-400" />
            <span className="text-[12px]">Loading…</span>
          </div>
        ) : (
          <div className="flex w-full max-w-xl flex-col items-center text-center">
            <div className="rounded-2xl shadow-[0_8px_30px_-8px_rgba(37,99,235,0.35)]">
              <Logo size={56} className="rounded-2xl" />
            </div>

            <h1 className="mt-6 text-[28px] font-semibold tracking-tight text-zinc-900">
              Welcome to Meetwit
            </h1>
            <p className="mt-2 max-w-md text-[14px] leading-relaxed text-zinc-500">
              {meetings.length === 0
                ? 'Record any meeting and get a live transcript, an AI summary, and answers grounded in your own notes — all on your Mac.'
                : 'Pick a note from the sidebar, or start a new recording.'}
            </p>

            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={starting}
              className="mt-7 inline-flex items-center gap-2 rounded-full bg-brand-600 px-6 py-3 text-[14px] font-semibold text-white shadow-xs transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 focus-visible:ring-offset-2 disabled:opacity-80"
            >
              {starting ? (
                <>
                  <Spinner size={15} />
                  Starting…
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" strokeWidth={2.5} />
                  Start Recording
                </>
              )}
            </button>
            <p className="mt-2.5 text-[11px] text-zinc-400">
              or press{' '}
              <kbd className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 shadow-xs">
                ⌘N
              </kbd>
            </p>

            {/* Today's calendar (ADR-0004) — renders only when a calendar is
                connected. One click links the event + records pre-named. */}
            <div className="mt-8 flex w-full justify-center">
              <TodayMeetings />
            </div>
          </div>
        )}
      </div>

      {effectiveError && (
        <div className="relative border-t border-red-200 bg-red-50 px-5 py-2 text-[12px] text-red-700">
          <AlertCircle className="mr-2 inline h-3.5 w-3.5 align-middle" />
          {effectiveError}
        </div>
      )}
    </div>
  );
}

