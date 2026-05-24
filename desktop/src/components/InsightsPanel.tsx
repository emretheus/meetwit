import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bell, CheckCircle2, Lightbulb, X, Zap } from 'lucide-react';
import {
  useInsights,
  useMeetingStore,
  useUnreadInsightCount,
  type StoredInsight,
} from '@/stores/meetingStore';

/**
 * Bell button + popover that shows the proactive watcher's insights.
 *
 * Rendered next to the Start/Stop button in the meeting top bar. The badge
 * pulses when there are unread insights; opening the panel marks all as
 * acknowledged.
 */
export function InsightsPanel() {
  const insights = useInsights();
  const unread = useUnreadInsightCount();
  const acknowledgeAll = useMeetingStore((s) => s.acknowledgeAllInsights);
  const dismiss = useMeetingStore((s) => s.dismissInsight);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    acknowledgeAll();
  }, [open, acknowledgeAll]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onClickOutside);
    return () => window.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          insights.length === 0
            ? 'Copilot is watching the meeting'
            : `${insights.length} insight${insights.length === 1 ? '' : 's'}`
        }
        className={[
          'relative flex h-8 w-8 items-center justify-center rounded-md border transition-colors',
          unread > 0
            ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 shadow-xs'
            : 'border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-700 shadow-xs',
        ].join(' ')}
      >
        <Bell className="h-3.5 w-3.5" strokeWidth={2.25} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold tabular-nums text-white shadow-xs">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-10 z-20 w-96 rounded-xl border border-zinc-200 bg-white shadow-lg ring-1 ring-black/5">
          <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5">
            <div className="flex items-center gap-2 text-[13px] font-semibold tracking-tight text-zinc-900">
              <div className="flex h-5 w-5 items-center justify-center rounded-md bg-amber-50 text-amber-600">
                <Lightbulb className="h-3 w-3" />
              </div>
              Copilot insights
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {insights.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-xs text-zinc-500">
                Nothing flagged yet. I&apos;m watching for contradictions, risks, and decisions as
                the meeting unfolds.
              </p>
            </div>
          ) : (
            <ul className="max-h-[420px] divide-y divide-zinc-100 overflow-y-auto">
              {insights.map((insight) => (
                <li key={insight.id} className="px-4 py-3">
                  <InsightRow insight={insight} onDismiss={() => dismiss(insight.id)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function InsightRow({
  insight,
  onDismiss,
}: {
  insight: StoredInsight;
  onDismiss: () => void;
}) {
  const meta = kindMeta(insight.kind);
  const Icon = meta.Icon;
  return (
    <div>
      <div className="flex items-start gap-2">
        <div
          className={[
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded',
            meta.bg,
            meta.fg,
          ].join(' ')}
        >
          <Icon className="h-3 w-3" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-900">{insight.headline}</p>
            <SeverityChip severity={insight.severity} />
          </div>
          {insight.detail && (
            <p className="mt-1 text-xs leading-relaxed text-zinc-600">{insight.detail}</p>
          )}
          <blockquote className="mt-1.5 border-l-2 border-zinc-200 pl-2 text-[11px] italic text-zinc-500">
            “{insight.evidence_quote}”
            <span className="ml-2 font-mono not-italic">
              {formatTime(insight.evidence_timestamp_seconds)}
            </span>
          </blockquote>
          {insight.conflicts_with && (
            <p className="mt-1 text-[11px] text-amber-700">
              Conflicts with: {insight.conflicts_with}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss"
          className="rounded p-1 text-zinc-300 transition hover:bg-zinc-100 hover:text-zinc-700"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function kindMeta(
  kind: StoredInsight['kind'],
): { Icon: typeof Bell; bg: string; fg: string; label: string } {
  switch (kind) {
    case 'contradiction':
      return { Icon: AlertTriangle, bg: 'bg-red-100', fg: 'text-red-700', label: 'Contradiction' };
    case 'risk':
      return { Icon: AlertTriangle, bg: 'bg-amber-100', fg: 'text-amber-700', label: 'Risk' };
    case 'commitment':
      return { Icon: Zap, bg: 'bg-blue-100', fg: 'text-blue-700', label: 'Commitment' };
    case 'decision':
    default:
      return {
        Icon: CheckCircle2,
        bg: 'bg-green-100',
        fg: 'text-green-700',
        label: 'Decision',
      };
  }
}

function SeverityChip({ severity }: { severity: StoredInsight['severity'] }) {
  const styles =
    severity === 'high'
      ? 'bg-red-100 text-red-700'
      : severity === 'medium'
        ? 'bg-amber-100 text-amber-700'
        : 'bg-zinc-100 text-zinc-600';
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        styles,
      ].join(' ')}
    >
      {severity}
    </span>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
