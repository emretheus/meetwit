import { useEffect } from 'react';
import { Outlet, createRootRouteWithContext, useLocation, useNavigate } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { SideNav } from '@/components/SideNav';
import { RecordingPill } from '@/components/RecordingPill';
import { ToastStack } from '@/components/ToastStack';
import { SessionRecovery } from '@/components/SessionRecovery';
import { MeetingNudge } from '@/components/MeetingNudge';
import {
  detectionSetCalendarNudge,
  detectionSetEnabled,
  onTranscriptUpdate,
} from '@/lib/tauri';
import { appendTranscripts } from '@/lib/backend';
import { getPrefs } from '@/lib/prefs';
import { useBackendReady } from '@/lib/useBackendReady';
import { useInsightsWatcher } from '@/lib/useInsightsWatcher';
import { useMeetingStore } from '@/stores/meetingStore';

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

const ONBOARDED_KEY = 'meetwit:onboarded';

function RootLayout() {
  useInsightsWatcher();
  const navigate = useNavigate();
  const location = useLocation();
  const { ready: backendReady } = useBackendReady();

  // First-run gate. The `meetwit:onboarded` flag is the source of truth:
  //   - Missing  → send the user to /onboarding (fresh install OR explicit
  //                re-run via Settings).
  //   - "1"      → user has finished setup; never redirect.
  // We don't auto-write the flag based on DB state — doing that defeats the
  // "Re-run onboarding" button (the user would land on Home and we'd
  // immediately re-flag them as onboarded because old recordings exist).
  useEffect(() => {
    if (!backendReady) return;
    if (location.pathname === '/onboarding') return;
    if (localStorage.getItem(ONBOARDED_KEY) === '1') return;
    void navigate({ to: '/onboarding' });
  }, [backendReady, location.pathname, navigate]);

  // Lock down browser affordances in production: no right-click context menu,
  // no devtools/inspect/view-source shortcuts, no text-selection drag on
  // chrome. This keeps Meetwit feeling like a native app, not a web page.
  // Disabled in dev so we can still debug.
  useEffect(() => {
    if (!import.meta.env.PROD) return;

    const onContextMenu = (e: MouseEvent) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // F12 / Cmd+Opt+I / Cmd+Opt+J / Cmd+Opt+C → devtools.
      // Cmd+U → view source. Cmd+S/P handled elsewhere where meaningful.
      if (
        k === 'f12' ||
        ((e.metaKey || e.ctrlKey) && e.altKey && (k === 'i' || k === 'j' || k === 'c')) ||
        ((e.metaKey || e.ctrlKey) && k === 'u')
      ) {
        e.preventDefault();
      }
    };
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void onTranscriptUpdate((seg) => {
      const m = useMeetingStore.getState().meeting;
      if (!m) return;
      useMeetingStore.getState().appendSegment(seg, m.id);
      const payload: {
        text: string;
        audio_start: number;
        audio_end: number;
        speaker?: string;
      } = {
        text: seg.text,
        audio_start: seg.audio_start,
        audio_end: seg.audio_end,
      };
      if (seg.speaker !== null) payload.speaker = seg.speaker;
      void appendTranscripts(m.id, [payload]).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('appendTranscripts failed for meeting', m.id.slice(0, 8), err);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Sync auto-detect prefs → Rust at startup (ADR-0005): the master toggle and
  // the per-app "don't ask" list. Rust defaults detection ON; this reconciles
  // it with what the user actually chose.
  useEffect(() => {
    if (!backendReady) return;
    const prefs = getPrefs();
    void detectionSetEnabled(prefs.autoDetect).catch(() => undefined);
    void detectionSetCalendarNudge(prefs.calendarNudge).catch(() => undefined);
  }, [backendReady]);

  // Onboarding is a fullscreen wizard — hide the app chrome (sidebar +
  // recording pill) so the user has a focused, single-purpose flow.
  const chromeless = location.pathname === '/onboarding';

  if (chromeless) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-[var(--color-surface)]">
        {/* Draggable strip to replace the sidebar's drag region. macOS
            traffic lights overlap this band; the strip is invisible. */}
        <div data-tauri-drag-region className="h-8 shrink-0" />
        <main className="relative flex-1 overflow-y-auto bg-[var(--color-surface)]">
          <Outlet />
        </main>
        <ToastStack />
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--color-surface)]">
      <SideNav />
      <main className="relative flex flex-1 flex-col overflow-hidden bg-[var(--color-surface)]">
        <SessionRecovery />
        <div className="relative flex-1 overflow-y-auto">
          <Outlet />
        </div>
        <RecordingPill />
      </main>
      <MeetingNudge />
      <ToastStack />
    </div>
  );
}
