import { useEffect, useRef } from 'react';
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { onMeetingDetected, type MeetingDetected } from '@/lib/tauri';
import { linkEventToMeeting } from '@/lib/backend';
import { startMeeting } from '@/lib/meetingLifecycle';
import { useMeetingStore } from '@/stores/meetingStore';
import { toast } from '@/components/ToastStack';

/**
 * Headless driver for the auto-detect nudge (ADR-0005). On `meeting-detected`
 * from the Rust poller, it posts a NATIVE macOS notification (top-right). The
 * notification is click-to-act: clicking it focuses Meetwit and starts the
 * record flow. macOS native notifications can't carry reliable custom buttons,
 * so we use click-to-record rather than Record/Dismiss buttons.
 *
 * Renders nothing — it's all side effects (notification + click handling).
 */
export function MeetingNudge() {
  // The most-recent detected payload, so the (single) onAction handler can act
  // on the right meeting when the user clicks the notification.
  const pendingRef = useRef<MeetingDetected | null>(null);
  const permissionRef = useRef<boolean | null>(null);

  async function startFromDetected(detected: MeetingDetected) {
    // Already recording → ignore.
    if (useMeetingStore.getState().running || !detected.eventId) return;
    try {
      // Link the calendar event → pre-named meeting → record.
      const meeting = await linkEventToMeeting(detected.eventId);
      await startMeeting(meeting);
    } catch (err) {
      toast({
        title: "Couldn't start recording",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  useEffect(() => {
    let offDetected: (() => void) | null = null;
    let offAction: { unregister: () => Promise<void> } | null = null;

    // Clicking the native notification → focus the window + start recording.
    void onAction(() => {
      const detected = pendingRef.current;
      pendingRef.current = null;
      if (!detected) return;
      void getCurrentWindow().setFocus().catch(() => undefined);
      void startFromDetected(detected);
    }).then((listener) => {
      offAction = listener;
    });

    void onMeetingDetected(async (payload) => {
      pendingRef.current = payload;

      // Ensure permission once (prompts on first nudge).
      if (permissionRef.current === null) {
        permissionRef.current = await isPermissionGranted();
        if (!permissionRef.current) {
          permissionRef.current = (await requestPermission()) === 'granted';
        }
      }
      if (!permissionRef.current) return; // user denied — stay silent

      const label = payload.appName ?? 'Your meeting';
      sendNotification({
        title: `${label} is starting`,
        body: 'Click to record it with Meetwit.',
      });
    }).then((unlisten) => {
      offDetected = unlisten;
    });

    return () => {
      offDetected?.();
      void offAction?.unregister();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
