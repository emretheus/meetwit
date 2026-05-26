import { useEffect, useState } from 'react';
import { backendStatus, onBackendFailed, onBackendReady } from '@/lib/tauri';
import { setBackendBaseUrl } from '@/lib/backend';

/** Pull the resolved base URL from Rust and point the HTTP client at it. The
 *  sidecar uses a dynamic (OS-assigned) port, so this must run before any
 *  backend fetch — otherwise calls hit the stale fallback port. */
async function syncBaseUrl(): Promise<boolean> {
  try {
    const s = await backendStatus();
    if (s.base_url) setBackendBaseUrl(s.base_url);
    return s.running;
  } catch {
    return false;
  }
}

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
      // Optimistic check — common case: sidecar was already up. Also resolves
      // and stores the dynamic base URL.
      const running = await syncBaseUrl();
      if (!cancelled && running) {
        setReady(true);
        return;
      }

      // Otherwise wait for the event the Rust core emits when /health goes green.
      // Re-sync the base URL first so fetches use the right (dynamic) port.
      unlistenReady = await onBackendReady(() => {
        void syncBaseUrl().finally(() => {
          if (!cancelled) setReady(true);
        });
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
