import type { ReactNode } from 'react';

export interface TabOption<T extends string> {
  value: T;
  label: string;
  badge?: ReactNode;
  icon?: ReactNode;
}

interface TabsProps<T extends string> {
  value: T;
  options: ReadonlyArray<TabOption<T>>;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  variant?: 'underline' | 'pill';
  className?: string;
}

/**
 * Minimal tab strip. Two variants:
 *   - underline (default) — bottom-border accent, used for in-page section
 *     switching (Summary / Copilot, Settings sub-tabs).
 *   - pill — segmented control look, used for filter rows.
 */
export function Tabs<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  variant = 'underline',
  className = '',
}: TabsProps<T>) {
  if (variant === 'pill') {
    return (
      <div
        className={[
          'inline-flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5 shadow-xs',
          className,
        ].join(' ')}
        role="tablist"
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(opt.value)}
              className={[
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors',
                active
                  ? 'bg-zinc-900 text-white shadow-xs'
                  : 'text-zinc-600 hover:text-zinc-900',
              ].join(' ')}
            >
              {opt.icon}
              {opt.label}
              {opt.badge}
            </button>
          );
        })}
      </div>
    );
  }

  const pad = size === 'sm' ? 'px-2.5 py-1.5 text-[11px]' : 'px-3 py-2 text-[12px]';

  return (
    <div
      className={['flex items-center gap-0.5 border-b border-zinc-200', className].join(' ')}
      role="tablist"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={[
              '-mb-px inline-flex items-center gap-1.5 border-b-2 font-medium transition-colors',
              pad,
              active
                ? 'border-brand-600 text-zinc-900'
                : 'border-transparent text-zinc-500 hover:text-zinc-900',
            ].join(' ')}
          >
            {opt.icon}
            {opt.label}
            {opt.badge}
          </button>
        );
      })}
    </div>
  );
}
