import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { listActionItems, patchActionItem, type ActionItemOut } from '@/lib/backend';

export const Route = createFileRoute('/tasks')({
  component: TasksPage,
});

function TasksPage() {
  const [items, setItems] = useState<ActionItemOut[]>([]);
  const [filter, setFilter] = useState<'all' | 'open' | 'done'>('open');
  const [error, setError] = useState<string | null>(null);

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
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function toggle(item: ActionItemOut) {
    const nextStatus = item.status === 'done' ? 'open' : 'done';
    await patchActionItem(item.id, { status: nextStatus });
    void refresh();
  }

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Action items</h1>
        <div className="flex gap-1 text-xs">
          {(['all', 'open', 'done'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`rounded px-2.5 py-1 ${
                filter === f
                  ? 'bg-neutral-800 text-white'
                  : 'text-neutral-400 hover:bg-neutral-900'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-6 text-sm text-neutral-500">
          No {filter !== 'all' ? filter : ''} action items.
        </p>
      ) : (
        <ul className="mt-6 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-900/50 px-3 py-2"
            >
              <input
                type="checkbox"
                checked={item.status === 'done'}
                onChange={() => void toggle(item)}
                className="mt-1 h-4 w-4 cursor-pointer"
              />
              <div className="min-w-0 flex-1">
                <p
                  className={`text-sm ${
                    item.status === 'done' ? 'text-neutral-500 line-through' : 'text-neutral-100'
                  }`}
                >
                  {item.task}
                </p>
                <p className="text-xs text-neutral-500">
                  {item.owner && `${item.owner} · `}
                  {item.deadline && `due ${item.deadline} · `}
                  meeting {item.meeting_id.slice(0, 8)}…
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-4 text-sm text-red-400">✗ {error}</p>}
    </div>
  );
}
