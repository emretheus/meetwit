import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Centered dialog with backdrop. Esc closes; clicking backdrop closes.
 * Focus is left to the user — modals here are short and have a clear primary
 * action, no deep focus traps needed.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const widthClass = size === 'sm' ? 'max-w-md' : size === 'lg' ? 'max-w-2xl' : 'max-w-lg';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/30 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={[
          'w-full overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5',
          widthClass,
        ].join(' ')}
        role="dialog"
        aria-modal="true"
      >
        <header className="flex items-start justify-between gap-4 border-b border-zinc-100 px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">{title}</h2>
            {description && (
              <p className="mt-0.5 text-[12px] text-zinc-500">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Close"
            className="-mr-1 -mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
