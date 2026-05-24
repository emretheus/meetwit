import { useCallback, useEffect, useState } from 'react';
import { Mic, Users, Video } from 'lucide-react';
import {
  linkEventToMeeting,
  listCalendarAccounts,
  listCalendarEvents,
  listMeetings,
  type CalendarEventOut,
} from '@/lib/backend';
import { startMeeting } from '@/lib/meetingLifecycle';
import { onCalendarConnected } from '@/lib/tauri';
import { Button, Spinner } from '@/components/ui';
import { toast } from '@/components/ToastStack';

const CONF_LABEL: Record<string, string> = {
  meet: 'Google Meet',
  zoom: 'Zoom',
  teams: 'Teams',
};

function formatClock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function initials(name: string | null, email: string | null): string {
  const src = name?.trim() || email?.trim() || '?';
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }
  return src.slice(0, 2).toUpperCase();
}

/**
 * Home "Today" section (ADR-0004). Shows today's calendar events when a
 * calendar is connected; one click links the event to a pre-named meeting and
 * starts recording in place. Renders nothing when no calendar is connected
 * (the welcome hero is enough).
 */
export function TodayMeetings({ onStarted }: { onStarted?: () => void }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<CalendarEventOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);

  const load = useCallback(() => {
    void listCalendarAccounts()
      .then(async (accts) => {
        const hasCalendar = accts.length > 0;
        setConnected(hasCalendar);
        if (!hasCalendar) return;
        const [evs, meetings] = await Promise.all([listCalendarEvents(), listMeetings()]);
        // A cached event can still point at a meeting the user has since
        // deleted. Treat such stale links as unlinked so the row shows
        // "Record" (recordable again), not a dead "Open note".
        const liveIds = new Set(meetings.map((m) => m.id));
        setEvents(
          evs.map((ev) =>
            ev.meeting_id && !liveIds.has(ev.meeting_id) ? { ...ev, meeting_id: null } : ev,
          ),
        );
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    let off: (() => void) | null = null;
    onCalendarConnected(() => load()).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, [load]);

  async function handleRecord(ev: CalendarEventOut) {
    if (startingId) return;
    setStartingId(ev.id);
    try {
      const meeting = await linkEventToMeeting(ev.id);
      await startMeeting(meeting);
      onStarted?.();
    } catch (err) {
      toast({
        title: "Couldn't start recording",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setStartingId(null);
    }
  }

  // Nothing to show until we know a calendar is connected.
  if (loading || !connected) return null;

  if (events.length === 0) {
    return (
      <div className="w-full max-w-xl rounded-xl border border-zinc-200 bg-white/70 px-4 py-3 text-center">
        <p className="text-[12.5px] text-zinc-500">No meetings on your calendar today.</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl text-left">
      <p className="mb-2 text-[11px] font-semibold tracking-wider uppercase text-zinc-400">
        Today
      </p>
      <ul className="space-y-2">
        {events.map((ev) => {
          const conf = ev.conference_kind ? CONF_LABEL[ev.conference_kind] : null;
          return (
            <li
              key={ev.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-white p-3 shadow-xs"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] tabular-nums text-zinc-500">
                    {formatClock(ev.starts_at)}
                  </span>
                  <p className="truncate text-[13px] font-medium text-zinc-900">
                    {ev.title ?? 'Untitled event'}
                  </p>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-zinc-500">
                  {conf && (
                    <span className="inline-flex items-center gap-1">
                      <Video className="h-3 w-3" />
                      {conf}
                    </span>
                  )}
                  {ev.attendees.length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {ev.attendees.length}
                    </span>
                  )}
                  {ev.attendees.length > 0 && (
                    <span className="flex -space-x-1.5">
                      {ev.attendees.slice(0, 4).map((a, i) => (
                        <span
                          key={a.email ?? i}
                          title={a.name ?? a.email ?? undefined}
                          className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-100 text-[9px] font-semibold text-zinc-600 ring-1 ring-white"
                        >
                          {initials(a.name, a.email)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
              {ev.meeting_id ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    window.history.pushState({}, '', `/meeting/${ev.meeting_id}/summary`);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }}
                >
                  Open note
                </Button>
              ) : (
                <Button
                  size="sm"
                  leftIcon={
                    startingId === ev.id ? (
                      <Spinner size={12} />
                    ) : (
                      <Mic className="h-3.5 w-3.5" />
                    )
                  }
                  onClick={() => void handleRecord(ev)}
                  disabled={startingId !== null}
                >
                  Record
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
