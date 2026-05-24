import { useCallback, useEffect, useState } from 'react';
import { Calendar, RefreshCw } from 'lucide-react';
import { listCalendarAccounts, type CalendarAccountOut } from '@/lib/backend';
import {
  calendarAvailable,
  calendarConnectGoogle,
  calendarDisconnect,
  calendarSync,
  onCalendarConnected,
  onCalendarDisconnected,
} from '@/lib/tauri';
import { Badge, Button } from '@/components/ui';
import { toast } from '@/components/ToastStack';

/**
 * Settings → Calendar card (ADR-0004). Connect/disconnect a read-only Google
 * Calendar; the OAuth + token storage all happen in the Rust core.
 */
export function CalendarSettings() {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<CalendarAccountOut[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void listCalendarAccounts()
      .then(setAccounts)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void calendarAvailable()
      .then(setAvailable)
      .catch(() => setAvailable(false));
    refresh();
  }, [refresh]);

  // Refresh the account list whenever a connect/disconnect lands in Rust.
  useEffect(() => {
    let offConnected: (() => void) | null = null;
    let offDisconnected: (() => void) | null = null;
    onCalendarConnected(() => refresh()).then((fn) => {
      offConnected = fn;
    });
    onCalendarDisconnected((email) => {
      toast({
        title: 'Calendar disconnected',
        description: `Access for ${email} was revoked — reconnect to keep syncing.`,
        tone: 'error',
      });
      refresh();
    }).then((fn) => {
      offDisconnected = fn;
    });
    return () => {
      offConnected?.();
      offDisconnected?.();
    };
  }, [refresh]);

  async function handleConnect() {
    setBusy(true);
    try {
      const email = await calendarConnectGoogle();
      toast({ title: 'Calendar connected', description: email, tone: 'success' });
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg !== 'cancelled') {
        toast({ title: "Couldn't connect calendar", description: msg, tone: 'error' });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSync(acct: CalendarAccountOut) {
    setBusy(true);
    try {
      const n = await calendarSync(acct.id, acct.email);
      toast({ title: 'Calendar synced', description: `${n} events`, tone: 'success' });
      refresh();
    } catch (err) {
      toast({
        title: 'Sync failed',
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect(acct: CalendarAccountOut) {
    setBusy(true);
    try {
      await calendarDisconnect(acct.id, acct.email);
      toast({ title: 'Disconnected', description: acct.email, tone: 'success' });
      refresh();
    } catch (err) {
      toast({
        title: 'Disconnect failed',
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-zinc-500">
        Connect a calendar to auto-name meetings and see today&apos;s agenda on Home. Read-only —
        Meetwit never writes to your calendar, and your audio never leaves this Mac.
      </p>

      {accounts.length === 0 ? (
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50/60 p-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white text-zinc-500 ring-1 ring-inset ring-zinc-200">
              <Calendar className="h-4 w-4" />
            </div>
            <div>
              <p className="text-[12.5px] font-medium text-zinc-800">Google Calendar</p>
              <p className="text-[11px] text-zinc-500">Not connected</p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => void handleConnect()}
            disabled={busy || available === false}
            title={
              available === false
                ? 'Calendar not configured in this build.'
                : undefined
            }
          >
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      ) : (
        accounts.map((acct) => (
          <div
            key={acct.id}
            className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-3"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-50 text-brand-600 ring-1 ring-inset ring-brand-100">
                <Calendar className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[12.5px] font-medium text-zinc-800">{acct.email}</p>
                  <Badge color="success" size="xs" dot>
                    Connected
                  </Badge>
                </div>
                <p className="text-[11px] text-zinc-500">
                  {acct.last_synced_at
                    ? `Last synced ${new Date(acct.last_synced_at).toLocaleString()}`
                    : 'Not synced yet'}
                </p>
              </div>
            </div>
            <div className="ml-3 flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RefreshCw className="h-3 w-3" />}
                onClick={() => void handleSync(acct)}
                disabled={busy}
              >
                Sync now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleDisconnect(acct)}
                disabled={busy}
              >
                Disconnect
              </Button>
            </div>
          </div>
        ))
      )}

      <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50/40 p-3 opacity-70">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-white text-zinc-400 ring-1 ring-inset ring-zinc-200">
            <Calendar className="h-4 w-4" />
          </div>
          <p className="text-[12.5px] font-medium text-zinc-600">Microsoft Outlook</p>
        </div>
        <Badge color="neutral" size="xs">
          Coming soon
        </Badge>
      </div>
    </div>
  );
}
