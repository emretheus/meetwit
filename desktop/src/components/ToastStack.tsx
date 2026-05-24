import { useEffect } from 'react';
import { create } from 'zustand';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone?: 'success' | 'info' | 'error';
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => string;
  dismiss: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    set((s) => ({ toasts: [...s.toasts, { id, durationMs: 5000, tone: 'info', ...t }] }));
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(t: Omit<ToastItem, 'id'>): string {
  return useToastStore.getState().push(t);
}

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed bottom-6 left-6 z-40 flex flex-col gap-2">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast.durationMs || toast.durationMs <= 0) return;
    const id = window.setTimeout(onDismiss, toast.durationMs);
    return () => window.clearTimeout(id);
  }, [toast.durationMs, onDismiss]);

  const tone = toast.tone ?? 'info';
  const iconColor =
    tone === 'success' ? 'text-emerald-500' : tone === 'error' ? 'text-red-500' : 'text-brand-500';
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? XCircle : Info;

  return (
    <div className="pointer-events-auto flex w-[360px] items-start gap-2.5 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg ring-1 ring-black/5">
      <Icon className={['mt-0.5 h-4 w-4 shrink-0', iconColor].join(' ')} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-zinc-900">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-600">{toast.description}</p>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action!.onClick();
              onDismiss();
            }}
            className="mt-1.5 text-[12px] font-semibold text-brand-700 hover:text-brand-800"
          >
            {toast.action.label} →
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className="rounded p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
