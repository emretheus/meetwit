import { useEffect, useRef, useState } from 'react';
import {
  micRecordStart,
  micRecordStop,
  micStart,
  micStatus,
  micStop,
  type MicStatus,
} from '@/lib/tauri';

const POLL_MS = 100;

export function MicControls() {
  const [status, setStatus] = useState<MicStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const pollRef = useRef<number | null>(null);

  function startPolling() {
    stopPolling();
    pollRef.current = window.setInterval(() => {
      micStatus()
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

  useEffect(() => {
    // Initial status (mic likely off).
    micStatus().then(setStatus).catch(() => undefined);
    return stopPolling;
  }, []);

  async function handleStart() {
    setError(null);
    try {
      const s = await micStart();
      setStatus(s);
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleStop() {
    setError(null);
    try {
      await micStop();
      stopPolling();
      setStatus({ running: false, recording: false, level: { rms: 0, clipped: false } });
      setRecording(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRecordStart() {
    setError(null);
    try {
      const filename = `mic-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
      const path = await micRecordStart(filename);
      setRecordingPath(path);
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRecordStop() {
    setError(null);
    try {
      const path = await micRecordStop();
      setRecording(false);
      if (path) setRecordingPath(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const running = status?.running ?? false;
  const rms = status?.level.rms ?? 0;
  const clipped = status?.level.clipped ?? false;
  // Map RMS (linear, typically 0..0.5) to 0..100% for the bar.
  const widthPct = Math.min(100, Math.round(rms * 400));

  return (
    <section className="w-full rounded-lg border border-neutral-800 bg-neutral-900/50 p-5">
      <h2 className="text-sm font-medium text-neutral-300">Microphone</h2>
      <p className="mt-1 text-xs text-neutral-500">
        cpal default input → 16 kHz mono ring buffer. Recording writes WAV under app data.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {running ? (
          <button
            type="button"
            onClick={handleStop}
            className="rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-100 transition hover:bg-neutral-700"
          >
            Stop mic
          </button>
        ) : (
          <button
            type="button"
            onClick={handleStart}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-500"
          >
            Start mic
          </button>
        )}

        {running && !recording && (
          <button
            type="button"
            onClick={handleRecordStart}
            className="rounded-md border border-red-700 bg-red-900/30 px-3 py-1.5 text-sm text-red-200 transition hover:bg-red-900/50"
          >
            ● Record WAV
          </button>
        )}
        {running && recording && (
          <button
            type="button"
            onClick={handleRecordStop}
            className="rounded-md border border-red-500 bg-red-500/20 px-3 py-1.5 text-sm text-red-100 transition hover:bg-red-500/30"
          >
            ◼ Stop recording
          </button>
        )}
      </div>

      <div className="mt-4">
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
          <div
            className={`h-full transition-[width] duration-75 ${
              clipped ? 'bg-red-500' : 'bg-brand-500'
            }`}
            style={{ width: `${widthPct}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-neutral-500">
          {running ? (
            <>
              RMS: <span className="font-mono">{rms.toFixed(4)}</span>
              {clipped && <span className="ml-2 text-red-400">CLIP</span>}
            </>
          ) : (
            'mic idle'
          )}
        </p>
      </div>

      {recordingPath && (
        <p className="mt-3 text-xs text-neutral-400">
          {recording ? '● recording → ' : 'last recording: '}
          <code className="text-neutral-300">{recordingPath}</code>
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-400">✗ {error}</p>}
    </section>
  );
}
