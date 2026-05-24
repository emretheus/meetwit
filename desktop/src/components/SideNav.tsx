import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import {
  FileText,
  Home,
  Info,
  Mic,
  Settings as SettingsIcon,
  Square,
  type LucideIcon,
} from 'lucide-react';
import { Logo } from './Logo';
import { SidebarSearch } from './SidebarSearch';
import { SidebarNotesList } from './SidebarNotesList';
import { CommandPalette } from './CommandPalette';
import { Spinner } from '@/components/ui';
import {
  useMeetingStore,
  useRunning,
  useStartedAt,
} from '@/stores/meetingStore';
import { startMeeting, stopMeeting } from '@/lib/meetingLifecycle';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const PRIMARY: NavItem[] = [{ to: '/', label: 'Home', icon: Home }];

export function SideNav() {
  const location = useLocation();
  const navigate = useNavigate();
  const running = useRunning();
  const startedAt = useStartedAt();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [, force] = useState(0);

  // Tick for the recording timer label.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (cmd && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void handleStart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    try {
      // Record in place: Home is the recording surface (Meetily style), so we
      // route there (no-op if already there) and start — no live-page jump.
      await navigate({ to: '/' });
      if (!running) {
        try {
          await startMeeting();
        } catch {
          /* surfaces via store.error */
        }
      }
    } finally {
      setStarting(false);
    }
  }

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      await stopMeeting();
    } finally {
      setStopping(false);
    }
  }

  const elapsed =
    running && startedAt ? formatElapsed(Date.now() - startedAt) : null;
  const meetingId = useMeetingStore.getState().meeting?.id;

  return (
    <>
      <aside
        className="flex w-[232px] shrink-0 flex-col border-r border-[var(--color-sidebar-border)] bg-[var(--color-sidebar-bg)] text-[var(--color-sidebar-text)]"
        data-tauri-drag-region
      >
        {/* Brand — soundwave-M logo + wordmark */}
        <div data-tauri-drag-region className="px-4 pt-10 pb-3">
          <div className="flex items-center gap-2.5 rounded-2xl bg-white px-3 py-2.5 ring-1 ring-[var(--color-sidebar-border)]">
            <Logo size={26} />
            <span className="text-[16px] font-bold tracking-tight text-zinc-900">
              Meetwit
            </span>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 pb-3">
          <SidebarSearch onOpen={() => setPaletteOpen(true)} />
        </div>

        {/* Primary nav — large, bold */}
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 pt-2">
          {PRIMARY.map((item) => {
            const active =
              location.pathname === item.to ||
              (item.to !== '/' && location.pathname.startsWith(item.to));
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={[
                  'group flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-[15px] font-semibold transition-colors',
                  active
                    ? 'text-zinc-900'
                    : 'text-zinc-700 hover:bg-white/60 hover:text-zinc-900',
                ].join(' ')}
              >
                <Icon
                  className={[
                    'h-[18px] w-[18px] shrink-0',
                    active ? 'text-zinc-900' : 'text-zinc-700',
                  ].join(' ')}
                  strokeWidth={active ? 2.25 : 2}
                />
                <span className="tracking-tight">{item.label}</span>
              </Link>
            );
          })}

          <div className="mt-3 mb-0.5 flex items-center gap-2.5 px-3">
            <FileText className="h-[18px] w-[18px] shrink-0 text-zinc-700" strokeWidth={2} />
            <span className="text-[15px] font-semibold tracking-tight text-zinc-900">
              Meetings
            </span>
          </div>
          <SidebarNotesList />
        </nav>

        {/* Footer stack — Meetily ordering: red CTA / Import Audio / Settings / About / version */}
        <div className="flex flex-col gap-1.5 border-t border-[var(--color-sidebar-border)] px-3 pt-3 pb-3">
          {running ? (
            <button
              type="button"
              onClick={() => void handleStop()}
              disabled={stopping}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-red-500/15 px-3 py-2.5 text-[13px] font-semibold text-red-700 ring-1 ring-inset ring-red-200 transition hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/40 disabled:opacity-70"
              title="Stop recording"
            >
              {stopping ? (
                <>
                  <Spinner size={12} />
                  Stopping…
                </>
              ) : (
                <>
                  <Square className="h-3.5 w-3.5 fill-current" />
                  Recording {elapsed ?? ''}
                </>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={starting}
              className="group flex w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-3 py-2.5 text-[13px] font-semibold text-white shadow-xs transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/40 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-sidebar-bg)] disabled:opacity-80"
            >
              {starting ? (
                <>
                  <Spinner size={12} />
                  Starting…
                </>
              ) : (
                <>
                  <Mic className="h-3.5 w-3.5" strokeWidth={2.5} />
                  Start Recording
                </>
              )}
            </button>
          )}

          <FooterPill
            to="/settings"
            label="Settings"
            icon={SettingsIcon}
            location={location}
          />

          <button
            type="button"
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-white px-3 py-2.5 text-[13px] font-semibold text-zinc-700 ring-1 ring-inset ring-[var(--color-sidebar-border)] transition hover:bg-zinc-50 disabled:cursor-not-allowed"
            title={meetingId ? `Active meeting · ${meetingId.slice(0, 8)}` : 'Meetwit · local · private'}
          >
            <Info className="h-3.5 w-3.5" strokeWidth={2.25} />
            About
          </button>

          <p className="mt-1 text-center text-[10.5px] text-zinc-400">v0.1.0</p>
        </div>
      </aside>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

function FooterPill({
  to,
  label,
  icon: Icon,
  location,
}: {
  to: string;
  label: string;
  icon: LucideIcon;
  location: { pathname: string };
}) {
  const active = location.pathname.startsWith(to);
  return (
    <Link
      to={to}
      className={[
        'flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition',
        active
          ? 'bg-white text-zinc-900 ring-1 ring-inset ring-[var(--color-sidebar-border)] shadow-xs'
          : 'bg-white text-zinc-700 ring-1 ring-inset ring-[var(--color-sidebar-border)] hover:bg-zinc-50',
      ].join(' ')}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={2.25} />
      {label}
    </Link>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
