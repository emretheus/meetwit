import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, X } from 'lucide-react';
import { listMeetings, patchMeeting, type Meeting } from '@/lib/backend';
import { useBackendReady } from '@/lib/useBackendReady';
import { useMeetingStore, useRunning } from '@/stores/meetingStore';
import { Spinner } from '@/components/ui';

/**
 * Crash/session recovery. On launch, find meetings the DB still thinks are
 * "recording" — these are orphaned by a crash or hard-quit (a clean stop
 * flips them to "completed"). We surface a banner offering to finalize them
 * so they don't sit forever in a half-recorded state.
 *
 * We exclude the currently-active meeting (if a recording is genuinely in
 * progress) so we never offer to finalize a live session.
 */
export function SessionRecovery() {
  const { ready } = useBackendReady();
  const running = useRunning();
  const [orphans, setOrphans] = useState<Meeting[]>([]);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const activeId = useMeetingStore.getState().meeting?.id;
    void listMeetings()
      .then((all) => {
        const stuck = all.filter(
          (m) => m.status === 'recording' && m.id !== (running ? activeId : undefined),
        );
        setOrphans(stuck);
      })
      .catch(() => undefined);
    // Run once on first ready. Re-running on every render would re-surface
    // after the user finalizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (dismissed || orphans.length === 0) return null;

  async function finalizeAll() {
    setBusy(true);
    try {
      const endedAt = new Date().toISOString();
      await Promise.all(
        orphans.map((m) =>
          patchMeeting(m.id, { status: 'completed', ended_at: endedAt }).catch(() => undefined),
        ),
      );
      setOrphans([]);
    } finally {
      setBusy(false);
    }
  }

  const first = orphans[0]!;
  const count = orphans.length;

  return (
    <div className="border-b border-amber-200 bg-amber-50/80 px-5 py-2.5">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-amber-900">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">
            {count === 1 ? (
              <>
                A recording didn&apos;t finish cleanly:{' '}
                <Link
                  to="/meeting/$id/summary"
                  params={{ id: first.id }}
                  className="font-medium underline hover:text-amber-700"
                >
                  {first.title ?? 'Untitled meeting'}
                </Link>
                .
              </>
            ) : (
              <>{count} recordings didn&apos;t finish cleanly.</>
            )}{' '}
            Finalize {count === 1 ? 'it' : 'them'} to save the transcript so far.
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => void finalizeAll()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-2.5 py-1 text-[12px] font-semibold text-white transition hover:bg-amber-700 disabled:opacity-70"
          >
            {busy && <Spinner size={11} />}
            Finalize{count > 1 ? ` ${count}` : ''}
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            title="Dismiss"
            className="rounded p-1 text-amber-600 transition hover:bg-amber-100 hover:text-amber-800"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
