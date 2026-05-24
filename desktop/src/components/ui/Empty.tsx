import type { ReactNode } from 'react';

interface EmptyProps {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Tighter padding for empty states inside a side panel. */
  compact?: boolean;
}

export function Empty({
  icon,
  title,
  description,
  action,
  className = '',
  compact = false,
}: EmptyProps) {
  return (
    <div
      className={[
        'flex flex-col items-center justify-center rounded-xl border border-dashed border-zinc-200',
        'bg-white/40 text-center',
        compact ? 'px-5 py-8' : 'px-6 py-12',
        className,
      ].join(' ')}
    >
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-500 ring-1 ring-inset ring-zinc-200/60">
        {icon}
      </div>
      <h3 className="text-[13.5px] font-semibold tracking-tight text-zinc-900">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-zinc-500">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
