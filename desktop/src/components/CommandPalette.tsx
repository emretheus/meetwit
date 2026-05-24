import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  ArrowUpRight,
  CheckSquare,
  FileText,
  Home,
  Mic,
  Quote,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { listMeetings, searchTranscripts, type Meeting, type TranscriptHit } from '@/lib/backend';
import { startMeeting } from '@/lib/meetingLifecycle';
import { useBackendReady } from '@/lib/useBackendReady';
import { useRunning } from '@/stores/meetingStore';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

interface CommandItem {
  id: string;
  group: 'Notes' | 'Navigate' | 'Actions' | 'Transcripts';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  onSelect: () => void;
  /** Transcript hits are pre-filtered server-side; skip client fuzzy match. */
  rawMatch?: boolean;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matches(item: CommandItem, query: string): number {
  if (!query.trim()) return 1;
  const q = tokens(query);
  const hay = `${item.title} ${item.subtitle ?? ''} ${item.group}`.toLowerCase();
  let score = 0;
  for (const t of q) {
    const idx = hay.indexOf(t);
    if (idx === -1) return 0;
    score += t.length / hay.length + (idx === 0 ? 0.2 : 0);
  }
  return score;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [transcriptHits, setTranscriptHits] = useState<TranscriptHit[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const { ready } = useBackendReady();
  const running = useRunning();
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIdx(0);
      setTranscriptHits([]);
      return;
    }
    if (!ready) return;
    void listMeetings()
      .then(setMeetings)
      .catch(() => undefined);
  }, [open, ready]);

  // Debounced transcript-text search. Fires when the user types ≥2 chars.
  useEffect(() => {
    if (!open || !ready) return;
    const q = query.trim();
    if (q.length < 2) {
      setTranscriptHits([]);
      return;
    }
    const id = window.setTimeout(() => {
      void searchTranscripts(q, 8)
        .then(setTranscriptHits)
        .catch(() => setTranscriptHits([]));
    }, 200);
    return () => window.clearTimeout(id);
  }, [open, ready, query]);

  const items = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];

    list.push({
      id: 'action:start-recording',
      group: 'Actions',
      title: running ? 'Open live recording' : 'Start a new recording',
      subtitle: running ? 'Already in progress' : 'Mic + system audio · local',
      icon: <Mic className="h-3.5 w-3.5" />,
      onSelect: () => {
        if (!running) void startMeeting();
        void navigate({ to: '/meeting/live' });
        onClose();
      },
    });

    for (const m of meetings) {
      list.push({
        id: `note:${m.id}`,
        group: 'Notes',
        title: m.title ?? 'Untitled meeting',
        subtitle: `${new Date(m.started_at).toLocaleDateString()} · ${m.transcript_count} segments`,
        icon: <FileText className="h-3.5 w-3.5" />,
        onSelect: () => {
          void navigate({ to: '/meeting/$id/summary', params: { id: m.id } });
          onClose();
        },
      });
    }

    const navs: Array<{ to: string; title: string; sub: string; icon: React.ReactNode }> = [
      { to: '/', title: 'Home', sub: 'All notes', icon: <Home className="h-3.5 w-3.5" /> },
      {
        to: '/memory',
        title: 'Ask my notes',
        sub: 'Search every meeting',
        icon: <Sparkles className="h-3.5 w-3.5" />,
      },
      {
        to: '/tasks',
        title: 'Action items',
        sub: 'Extracted tasks',
        icon: <CheckSquare className="h-3.5 w-3.5" />,
      },
      {
        to: '/settings',
        title: 'Settings',
        sub: 'Configure Meetwit',
        icon: <SettingsIcon className="h-3.5 w-3.5" />,
      },
    ];
    for (const n of navs) {
      list.push({
        id: `nav:${n.to}`,
        group: 'Navigate',
        title: n.title,
        subtitle: n.sub,
        icon: n.icon,
        onSelect: () => {
          void navigate({ to: n.to });
          onClose();
        },
      });
    }

    // Transcript line hits (server-filtered). Marked rawMatch so they bypass
    // the client fuzzy filter — they're already relevant to the query.
    for (const h of transcriptHits) {
      list.push({
        id: `transcript:${h.transcript_id}`,
        group: 'Transcripts',
        title: h.snippet,
        subtitle: `${h.meeting_title ?? 'Untitled meeting'} · ${formatTime(h.audio_start)}`,
        icon: <Quote className="h-3.5 w-3.5" />,
        rawMatch: true,
        onSelect: () => {
          void navigate({ to: '/meeting/$id/summary', params: { id: h.meeting_id } });
          onClose();
        },
      });
    }
    return list;
  }, [meetings, transcriptHits, navigate, onClose, running]);

  const filtered = useMemo(() => {
    return items
      .map((item) => ({ item, score: item.rawMatch ? 0.5 : matches(item, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => {
    setActiveIdx(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const pick = filtered[activeIdx];
        if (pick) pick.onSelect();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, filtered, activeIdx, onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-cmd-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!open) return null;

  // Group filtered for display.
  const groups: Record<string, CommandItem[]> = {};
  filtered.forEach((it) => {
    groups[it.group] = groups[it.group] ?? [];
    groups[it.group]!.push(it);
  });
  const groupOrder: CommandItem['group'][] = ['Actions', 'Transcripts', 'Notes', 'Navigate'];

  let runningIdx = -1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/30 p-4 pt-[12vh] backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2.5">
          <Search className="h-4 w-4 text-zinc-400" />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, jump to a page, run an action…"
            className="flex-1 border-0 bg-transparent text-sm text-zinc-800 placeholder:text-zinc-400 focus:outline-none"
          />
          <kbd className="hidden shrink-0 items-center rounded border border-zinc-200 bg-white px-1 font-mono text-[10px] text-zinc-500 sm:inline-flex">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-zinc-400">No matches.</p>
          ) : (
            groupOrder.map((g) => {
              const items = groups[g];
              if (!items || items.length === 0) return null;
              return (
                <div key={g}>
                  <div className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wider uppercase text-zinc-400">
                    {g}
                  </div>
                  {items.map((item) => {
                    runningIdx += 1;
                    const isActive = runningIdx === activeIdx;
                    return (
                      <button
                        key={item.id}
                        data-cmd-idx={runningIdx}
                        type="button"
                        onMouseEnter={() => setActiveIdx(runningIdx)}
                        onClick={() => item.onSelect()}
                        className={[
                          'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                          isActive ? 'bg-brand-50 text-brand-900' : 'text-zinc-700 hover:bg-zinc-50',
                        ].join(' ')}
                      >
                        <div
                          className={[
                            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
                            isActive
                              ? 'bg-white text-brand-700 ring-1 ring-inset ring-brand-200'
                              : 'bg-zinc-100 text-zinc-600',
                          ].join(' ')}
                        >
                          {item.icon}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium">{item.title}</p>
                          {item.subtitle && (
                            <p className="truncate text-[11px] text-zinc-500">{item.subtitle}</p>
                          )}
                        </div>
                        <ArrowUpRight
                          className={[
                            'h-3.5 w-3.5 shrink-0',
                            isActive ? 'text-brand-500' : 'text-zinc-300',
                          ].join(' ')}
                        />
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50/60 px-3 py-1.5 text-[10px] text-zinc-500">
          <span>
            <kbd className="rounded border border-zinc-200 bg-white px-1 font-mono">↑↓</kbd> navigate ·{' '}
            <kbd className="rounded border border-zinc-200 bg-white px-1 font-mono">↵</kbd> open ·{' '}
            <kbd className="rounded border border-zinc-200 bg-white px-1 font-mono">esc</kbd> close
          </span>
          <span className="font-mono">{filtered.length} results</span>
        </div>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
