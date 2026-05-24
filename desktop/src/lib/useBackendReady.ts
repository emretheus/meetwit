import { useEffect, useState } from 'react';
import { backendStatus, onBackendFailed, onBackendReady } from '@/lib/tauri';

/**
 * One-line gate for "is the local Python sidecar reachable at /health?".
 *
 * Returns `true` once we either:
 *   1. observe `backendStatus().running === true`, OR
 *   2. receive the `backend-ready` Tauri event.
 *
 * Pages that fetch on mount should wrap their effect in
 * `useEffect(() => { if (!ready) return; … }, [ready])` to avoid the
 * "Could not connect" race during app boot (~500 ms on cold start).
 */
export function useBackendReady(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlistenReady: (() => void) | null = null;
    let unlistenFailed: (() => void) | null = null;

    void (async () => {
      // Optimistic check — common case: sidecar was already up.
      try {
        const s = await backendStatus();
        if (!cancelled && s.running) {
          setReady(true);
          return;
        }
      } catch {
        // ignore; fall through to the event-based path
      }

      // Otherwise wait for the event the Rust core emits when /health goes green.
      unlistenReady = await onBackendReady(() => {
        if (!cancelled) setReady(true);
      });
      unlistenFailed = await onBackendFailed((msg) => {
        if (!cancelled) setError(msg);
      });
    })();

    return () => {
      cancelled = true;
      unlistenReady?.();
      unlistenFailed?.();
    };
  }, []);

  return { ready, error };
}
