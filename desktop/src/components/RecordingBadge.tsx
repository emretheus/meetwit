import { useEffect, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Square } from 'lucide-react';
import { useMeetingStore, useRunning, useStartedAt } from '@/stores/meetingStore';
import { stopMeeting } from '@/lib/meetingLifecycle';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function RecordingBadge() {
  const running = useRunning();
  const startedAt = useStartedAt();
  const [, force] = useState(0);

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  if (!running || !startedAt) return null;

  const elapsed = formatElapsed(Date.now() - startedAt);
  const meetingId = useMeetingStore.getState().meeting?.id;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-orange-200 bg-orange-50/60 px-2.5 py-2 shadow-xs">
      <Link
        to="/meeting/live"
        className="flex flex-1 items-center gap-2 text-xs text-orange-800 transition hover:text-orange-900"
        title={meetingId ? `Meeting ${meetingId.slice(0, 8)}` : 'Live meeting'}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-500/60" />
          <span className="recording-dot relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="text-[9px] font-semibold tracking-wider uppercase text-orange-700">
            Recording
          </span>
          <span className="font-mono text-[12px] font-medium tabular-nums text-orange-900">
            {elapsed}
          </span>
        </span>
      </Link>
      <button
        type="button"
        onClick={() => void stopMeeting()}
        title="Stop recording"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-red-500 transition hover:bg-red-100 hover:text-red-700"
      >
        <Square className="h-3 w-3 fill-current" />
      </button>
    </div>
  );
}
