import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import {
  knowledgeStats,
  listActionItems,
  listMeetings,
  type ActionItemOut,
  type KnowledgeStats,
  type Meeting,
} from '@/lib/backend';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [openTasks, setOpenTasks] = useState<ActionItemOut[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, ms, ts] = await Promise.all([
          knowledgeStats(),
          listMeetings(),
          listActionItems({ status_filter: 'open' }),
        ]);
        setStats(s);
        setMeetings(ms);
        setOpenTasks(ts);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  return (
    <div className="px-8 py-6">
      <header>
        <h1 className="text-2xl font-semibold">Welcome to Meetwit</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Privacy-first AI meeting assistant.
        </p>
        <Link
          to="/meeting/live"
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
        >
          ● Start Live Meeting
        </Link>
      </header>

      <div className="mt-8 grid grid-cols-4 gap-3 text-sm">
        <Stat label="Indexed docs" value={stats?.indexed_count ?? 0} />
        <Stat label="Chunks" value={stats?.chunk_count ?? 0} />
        <Stat label="Meetings" value={meetings.length} />
        <Stat label="Open tasks" value={openTasks.length} />
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-medium">Recent meetings</h2>
        {meetings.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">No meetings yet.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {meetings.slice(0, 5).map((m) => (
              <li key={m.id}>
                <Link
                  to="/meeting/$id/summary"
                  params={{ id: m.id }}
                  className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900/50 px-3 py-2 text-sm hover:bg-neutral-900"
                >
                  <span className="font-medium">{m.title ?? 'Untitled meeting'}</span>
                  <span className="text-xs text-neutral-500">
                    {new Date(m.started_at).toLocaleString()} · {m.transcript_count} segments
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="mt-4 text-sm text-red-400">✗ {error}</p>}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-3">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-lg font-medium">{value}</div>
    </div>
  );
}
