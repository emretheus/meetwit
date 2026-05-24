import { useEffect, useRef } from 'react';
import { scanInsights } from '@/lib/backend';
import {
  useMeeting,
  useMeetingStore,
  useRunning,
  useSegments,
} from '@/stores/meetingStore';

/**
 * Background poller that asks the sidecar to scan recent transcript for
 * contradictions / risks / commitments / decisions and pushes them into the
 * meeting store.
 *
 * Strategy:
 *   - Only runs while a meeting is recording.
 *   - Polls every `INTERVAL_MS`, but skips the call if there isn't enough new
 *     transcript since the last scan (avoids burning the LLM on silence).
 *   - The scan endpoint is idempotent; if it returns insights we already
 *     have, the store dedupes by stable id.
 *
 * Mount this from `__root.tsx` so it survives navigation.
 */
const INTERVAL_MS = 20_000;
const MIN_NEW_SECONDS = 12; // require ~12s of fresh audio before scanning again

export function useInsightsWatcher(): void {
  const meeting = useMeeting();
  const running = useRunning();
  const segments = useSegments();
  const inFlight = useRef(false);
  const lastScanAt = useRef(0);

  // Stable refs so the interval callback always sees current state.
  const stateRef = useRef({ meeting, running, segments });
  stateRef.current = { meeting, running, segments };

  useEffect(() => {
    if (!running || !meeting) return;
    const tick = async () => {
      if (inFlight.current) return;
      const { meeting: m, running: r, segments: segs } = stateRef.current;
      if (!r || !m) return;
      // Bail if we haven't accumulated enough new transcript since the
      // last successful scan.
      const watermark = useMeetingStore.getState().insightsScannedThrough;
      const newEnd = segs.length > 0 ? segs[segs.length - 1]!.audio_end : 0;
      if (newEnd - watermark < MIN_NEW_SECONDS) return;
      // Throttle: never run faster than INTERVAL_MS regardless of segment
      // burst rate.
      if (Date.now() - lastScanAt.current < INTERVAL_MS - 1000) return;

      inFlight.current = true;
      lastScanAt.current = Date.now();
      try {
        const result = await scanInsights(m.id, watermark);
        useMeetingStore
          .getState()
          .addInsights(result.insights, result.scanned_through_seconds);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('insights scan failed:', err);
      } finally {
        inFlight.current = false;
      }
    };
    // Initial kick — after we already have 2 segments in (~enough text for
    // the first scan to be useful).
    const id = window.setInterval(() => void tick(), INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [running, meeting]);
}
