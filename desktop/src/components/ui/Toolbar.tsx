import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Spinner } from './Spinner';

interface ToolbarProps {
  children: ReactNode;
  className?: string;
  /** When true, renders with a top hairline separator (used above panes). */
  bordered?: boolean;
}

/** Horizontal toolbar — groups of small icon+label buttons. */
export function Toolbar({ children, className = '', bordered = false }: ToolbarProps) {
  return (
    <div
      className={[
        'flex items-center gap-1 bg-white px-3 py-1.5',
        bordered ? 'border-b border-zinc-200' : '',
        className,
      ].join(' ')}
      role="toolbar"
    >
      {children}
    </div>
  );
}

export function ToolbarGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={['flex items-center gap-1', className].join(' ')}>{children}</div>;
}

export function ToolbarSpacer() {
  return <div className="flex-1" />;
}

export function ToolbarDivider() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-zinc-200" />;
}

interface ToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  label: string;
  active?: boolean;
  loading?: boolean;
  tone?: 'neutral' | 'danger' | 'brand';
}

export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ icon, label, active, loading, tone = 'neutral', className = '', disabled, ...rest }, ref) => {
    const toneClass =
      tone === 'danger'
        ? active
          ? 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200'
          : 'text-red-600 hover:bg-red-50 hover:text-red-700'
        : tone === 'brand'
          ? active
            ? 'bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200'
            : 'text-zinc-700 hover:bg-zinc-100 hover:text-brand-700'
          : active
            ? 'bg-zinc-100 text-zinc-900 ring-1 ring-inset ring-zinc-200'
            : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900';
    const isDisabled = disabled || loading;
    return (
      <button
        ref={ref}
        type="button"
        disabled={isDisabled}
        className={[
          'inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30 focus-visible:ring-offset-1',
          isDisabled ? 'cursor-not-allowed opacity-60' : '',
          toneClass,
          className,
        ].join(' ')}
        {...rest}
      >
        {loading ? <Spinner size={12} /> : icon}
        {label}
      </button>
    );
  },
);
ToolbarButton.displayName = 'ToolbarButton';
