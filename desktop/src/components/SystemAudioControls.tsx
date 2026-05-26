import { useEffect, useRef, useState } from 'react';
import {
  systemAudioAvailable,
  systemAudioStart,
  systemAudioStatus,
  systemAudioStop,
  type SystemAudioStatus,
} from '@/lib/tauri';

const POLL_MS = 200;

export function SystemAudioControls() {
  const [status, setStatus] = useState<SystemAudioStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    systemAudioAvailable().then(setAvailable).catch(() => setAvailable(false));
    systemAudioStatus().then(setStatus).catch(() => undefined);
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  function startPolling() {
    if (pollRef.current !== null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      systemAudioStatus()
        .then(setStatus)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function handleStart() {
    setError(null);
    try {
      const s = await systemAudioStart();
      setStatus(s);
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop() {
    setError(null);
    try {
      await systemAudioStop();
      stopPolling();
      setStatus({ available: available ?? true, running: false, rms: 0 });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const running = status?.running ?? false;
  const rms = status?.rms ?? 0;
  const widthPct = Math.min(100, Math.round(rms * 400));

  if (available === false) {
    return (
      <section className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
        <h2 className="text-sm font-medium text-neutral-300">System audio</h2>
        <p className="mt-1 text-xs text-amber-400">
          Not available on this macOS version (requires macOS 13+).
        </p>
      </section>
    );
  }

  return (
    <section className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
      <h2 className="text-sm font-medium text-neutral-300">System audio</h2>
      <p className="mt-1 text-xs text-neutral-500">
        ScreenCaptureKit via Swift FFI → 16 kHz mono ring. Captures Zoom / Meet / Teams audio.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {running ? (
          <button
            type="button"
            onClick={handleStop}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 transition hover:bg-neutral-700"
          >
            Stop system audio
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStart}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-500"
          >
            Start system audio
          </button>
        )}
      </div>

      <div className="mt-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className="h-full bg-purple-500 transition-[width] duration-75"
            style={{ width: `${widthPct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-neutral-500">
          {running ? (
            <>RMS: <span className="font-mono">{rms.toFixed(4)}</span></>
          ) : (
            'system audio idle'
          )}
        </p>
      </div>

      <p className="mt-3 text-xs text-neutral-500">
        On first start, macOS will prompt for <strong>Screen Recording</strong> permission. Approve, then
        fully restart the app for SCK to see the new grant.
      </p>

      {error && <p className="mt-3 text-sm text-red-400">✗ {error}</p>}
    </section>
  );
}
