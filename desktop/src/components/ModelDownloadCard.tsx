import { CheckCircle2, Download as DownloadIcon, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

interface ModelDownloadCardProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  state: 'idle' | 'downloading' | 'done' | 'error';
  bytesDone?: number;
  bytesTotal?: number;
  ratePerSec?: number;
  onStart?: () => void;
  error?: string | null;
  /** 'bytes' shows MB labels; 'percent' shows just the % (for Ollama pulls). */
  unit?: 'bytes' | 'percent';
}

function fmtMB(b: number): string {
  return `${(b / 1_000_000).toFixed(1)} MB`;
}

export function ModelDownloadCard({
  icon,
  title,
  subtitle,
  state,
  bytesDone = 0,
  bytesTotal = 0,
  ratePerSec = 0,
  onStart,
  error,
  unit = 'bytes',
}: ModelDownloadCardProps) {
  const pct = bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3.5 shadow-xs">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-600 ring-1 ring-inset ring-zinc-200/60">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-[13px] font-semibold text-zinc-900">{title}</p>
            {state === 'done' && (
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
            )}
            {state === 'downloading' && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
            )}
            {state === 'idle' && onStart && (
              <button
                type="button"
                onClick={onStart}
                className="inline-flex items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-brand-700"
              >
                <DownloadIcon className="h-3 w-3" />
                Download
              </button>
            )}
          </div>
          <p className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</p>
        </div>
      </div>

      {state === 'downloading' && (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200">
            <div
              className="h-full bg-brand-500 transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-zinc-500 tabular-nums">
            <span>
              {unit === 'percent'
                ? 'Downloading…'
                : `${fmtMB(bytesDone)} / ${bytesTotal > 0 ? fmtMB(bytesTotal) : '?'}`}
            </span>
            <span>
              {unit === 'bytes' && ratePerSec > 0
                ? `${(ratePerSec / 1_000_000).toFixed(1)} MB/s`
                : ''}{' '}
              <span className="ml-1 font-semibold text-zinc-700">{pct}%</span>
            </span>
          </div>
        </div>
      )}

      {state === 'error' && error && (
        <p className="mt-2 text-[11px] text-red-600">{error}</p>
      )}
    </div>
  );
}
