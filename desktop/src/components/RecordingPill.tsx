import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Pause, Play, Square } from 'lucide-react';
import { usePaused, useRunning, useStartedAt } from '@/stores/meetingStore';
import { pauseMeeting, resumeMeeting, stopMeeting } from '@/lib/meetingLifecycle';
import { WaveformBars } from './WaveformBars';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Floating recording control. Mounts at app root and is visible on every
 * route EXCEPT `/meeting/live` (where the in-page toolbar handles recording).
 *
 * Pause / Resume · Stop (red) · Waveform bars + elapsed timer.
 */
export function RecordingPill() {
  const running = useRunning();
  const paused = usePaused();
  const startedAt = useStartedAt();
  const navigate = useNavigate();
  const [, force] = useState(0);
  // Freeze elapsed display at the moment of pause.
  const frozenRef = useRef<number | null>(null);

  // 1Hz tick — stops while paused so the timer holds.
  useEffect(() => {
    if (!running || paused) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running, paused]);

  useEffect(() => {
    if (paused && startedAt != null && frozenRef.current === null) {
      frozenRef.current = Date.now() - startedAt;
    }
    if (!paused) frozenRef.current = null;
  }, [paused, startedAt]);

  // Always visible while recording, on every screen (including the live
  // surface) — it's the persistent record indicator + quick pause/stop. It
  // must never disappear just because you navigated to the recording page.
  if (!running || !startedAt) return null;

  const elapsedMs = paused && frozenRef.current != null ? frozenRef.current : Date.now() - startedAt;
  const elapsed = formatElapsed(elapsedMs);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-zinc-200 bg-white px-1.5 py-1 shadow-lg ring-1 ring-black/5">
        <button
          type="button"
          onClick={() => void (paused ? resumeMeeting() : pauseMeeting())}
          title={paused ? 'Resume recording' : 'Pause recording'}
          aria-label={paused ? 'Resume recording' : 'Pause recording'}
          className="flex h-9 w-9 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
        >
          {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => void stopMeeting()}
          title="Stop recording"
          aria-label="Stop recording"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-red-500 text-white shadow-[0_2px_8px_-2px_rgba(239,68,68,0.55)] transition-colors hover:bg-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50 focus-visible:ring-offset-2"
        >
          <Square className="h-4 w-4 fill-current" />
        </button>
        <button
          type="button"
          onClick={() => void navigate({ to: '/' })}
          title="Open live meeting"
          className="flex h-9 items-center gap-2 rounded-full px-2.5 text-zinc-700 transition-colors hover:bg-zinc-50"
        >
          {paused ? (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-600">
              Paused
            </span>
          ) : (
            <WaveformBars />
          )}
          <span className="font-mono text-[12px] font-medium tabular-nums text-zinc-700">
            {elapsed}
          </span>
        </button>
      </div>
    </div>
  );
}
