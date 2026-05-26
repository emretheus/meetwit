import { Download as DownloadIcon } from 'lucide-react';

interface FloatingDownloadTileProps {
  title: string;
  bytesDone: number;
  bytesTotal: number;
  ratePerSec: number;
}

export function FloatingDownloadTile({
  title,
  bytesDone,
  bytesTotal,
  ratePerSec,
}: FloatingDownloadTileProps) {
  const pct = bytesTotal > 0 ? Math.min(100, Math.round((bytesDone / bytesTotal) * 100)) : 0;
  return (
    <div className="fixed right-6 top-6 z-40 w-[300px] rounded-xl border border-zinc-200 bg-white p-3 shadow-lg ring-1 ring-black/5">
      <div className="flex items-start gap-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-700">
          <DownloadIcon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12.5px] font-semibold text-zinc-900">{title}</p>
          <p className="text-[10.5px] text-zinc-500 tabular-nums">
            {(bytesDone / 1_000_000).toFixed(1)} /{' '}
            {bytesTotal > 0 ? (bytesTotal / 1_000_000).toFixed(1) : '?'} MB
            {ratePerSec > 0 && (
              <>
                {' · '}
                {(ratePerSec / 1_000_000).toFixed(1)} MB/s
              </>
            )}{' '}
            <span className="ml-1 font-semibold text-zinc-700">{pct}%</span>
          </p>
        </div>
      </div>
      <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-zinc-200">
        <div className="h-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
