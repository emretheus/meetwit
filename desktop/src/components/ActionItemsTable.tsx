import { Check } from 'lucide-react';
import type { ActionItemOut } from '@/lib/backend';

interface ActionItemsTableProps {
  items: ActionItemOut[];
  onToggle: (item: ActionItemOut) => void;
}

/**
 * Meetily-style structured table of action items.
 * Columns: Done · Task · Owner · Due · Status.
 */
export function ActionItemsTable({ items, onToggle }: ActionItemsTableProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xs">
      <table className="w-full table-fixed border-collapse text-[13px]">
        <thead className="bg-zinc-50/70">
          <tr className="text-left">
            <th className="w-8 px-3 py-2 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
              {' '}
            </th>
            <th className="px-3 py-2 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
              Task
            </th>
            <th className="w-28 px-3 py-2 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
              Owner
            </th>
            <th className="w-28 px-3 py-2 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
              Due
            </th>
            <th className="w-20 px-3 py-2 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((a) => {
            const done = a.status === 'done';
            return (
              <tr
                key={a.id}
                className={[
                  'border-t border-zinc-100 transition-colors hover:bg-zinc-50/60',
                  done ? 'bg-zinc-50/40' : '',
                ].join(' ')}
              >
                <td className="px-3 py-2.5 align-top">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={done}
                    onClick={() => onToggle(a)}
                    className={[
                      'flex h-4 w-4 items-center justify-center rounded border transition',
                      done
                        ? 'border-brand-600 bg-brand-600 text-white'
                        : 'border-zinc-300 hover:border-zinc-400',
                    ].join(' ')}
                  >
                    {done && <Check className="h-3 w-3" strokeWidth={3} />}
                  </button>
                </td>
                <td
                  className={[
                    'px-3 py-2.5 align-top leading-relaxed',
                    done ? 'text-zinc-400 line-through' : 'text-zinc-900',
                  ].join(' ')}
                >
                  {a.task}
                </td>
                <td className="px-3 py-2.5 align-top text-zinc-700">{a.owner ?? '—'}</td>
                <td className="px-3 py-2.5 align-top text-zinc-700">{a.deadline ?? '—'}</td>
                <td className="px-3 py-2.5 align-top">
                  <span
                    className={[
                      'inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase',
                      done
                        ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/60'
                        : 'bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-200',
                    ].join(' ')}
                  >
                    {a.status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
