import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Calendar, CheckSquare, User } from 'lucide-react';
import { listActionItems, patchActionItem, type ActionItemOut } from '@/lib/backend';
import { Card, Empty } from '@/components/ui';
import { useBackendReady } from '@/lib/useBackendReady';

export const Route = createFileRoute('/tasks')({
  component: TasksPage,
});

type Filter = 'all' | 'open' | 'done';

function TasksPage() {
  const [items, setItems] = useState<ActionItemOut[]>([]);
  const [filter, setFilter] = useState<Filter>('open');
  const [error, setError] = useState<string | null>(null);
  const { ready: backendReady } = useBackendReady();

  async function refresh() {
    try {
      const params: { status_filter?: string } = {};
      if (filter !== 'all') params.status_filter = filter;
      const fetched = await listActionItems(params);
      setItems(fetched);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!backendReady) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, backendReady]);

  async function toggle(item: ActionItemOut) {
    const nextStatus = item.status === 'done' ? 'open' : 'done';
    // Optimistic flip for instant feedback.
    setItems((prev) =>
      prev.map((a) => (a.id === item.id ? { ...a, status: nextStatus } : a)),
    );
    try {
      await patchActionItem(item.id, { status: nextStatus });
      // If the active filter would now hide this item, sync from server.
      if (filter !== 'all') void refresh();
    } catch {
      setItems((prev) =>
        prev.map((a) => (a.id === item.id ? { ...a, status: item.status } : a)),
      );
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-10 py-10">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold tracking-wider uppercase text-zinc-400">Tasks</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">Action items</h1>
          <p className="mt-1.5 text-sm text-zinc-500">Tasks extracted from your meetings.</p>
        </div>
        <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 shadow-xs">
          {(['all', 'open', 'done'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={[
                'rounded-md px-3 py-1 text-[12px] font-medium transition-colors',
                filter === f
                  ? 'bg-zinc-900 text-white shadow-xs'
                  : 'text-zinc-500 hover:text-zinc-900',
              ].join(' ')}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {items.length === 0 ? (
        <div className="mt-7">
          <Empty
            icon={<CheckSquare className="h-5 w-5" />}
            title={`No ${filter !== 'all' ? filter : ''} action items`}
            description="Action items appear here automatically after you process a meeting."
          />
        </div>
      ) : (
        <Card padded={false} className="mt-7 overflow-hidden">
          <ul className="divide-y divide-zinc-100">
            {items.map((item) => {
              const done = item.status === 'done';
              return (
                <li
                  key={item.id}
                  className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-zinc-50/80"
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={done}
                    onClick={() => void toggle(item)}
                    className={[
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition',
                      done
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-zinc-300 hover:border-zinc-400',
                    ].join(' ')}
                  >
                    {done && (
                      <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3">
                        <path
                          d="M2.5 6.5L5 9L9.5 3.5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p
                      className={[
                        'text-[13px] leading-snug',
                        done ? 'text-zinc-400 line-through' : 'text-zinc-900',
                      ].join(' ')}
                    >
                      {item.task}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                      {item.owner && (
                        <span className="inline-flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {item.owner}
                        </span>
                      )}
                      {item.deadline && (
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {item.deadline}
                        </span>
                      )}
                      <Link
                        to="/meeting/$id/summary"
                        params={{ id: item.meeting_id }}
                        className="font-mono text-[10px] text-zinc-400 transition hover:text-brand-700"
                      >
                        {item.meeting_id.slice(0, 8)}
                      </Link>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {error && (
        <p className="mt-4 text-[12px] text-red-600">{error}</p>
      )}
    </div>
  );
}
