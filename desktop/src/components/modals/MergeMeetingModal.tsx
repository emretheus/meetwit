import { useEffect, useState } from 'react';
import { Check, GitMerge } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from '@/components/ui';
import { listMeetings, mergeMeetings, type Meeting } from '@/lib/backend';

interface MergeMeetingModalProps {
  open: boolean;
  onClose: () => void;
  /** The meeting everything merges INTO (kept; sources are folded in + deleted). */
  targetId: string;
  /** Called after a successful merge so the page can refresh. */
  onMerged: (transcriptsMerged: number) => void;
}

/**
 * Fold other meetings into this one (#393). Sources are appended to the target
 * timeline, their content reassigned, and the sources deleted. The target's
 * summary is regenerated on next run.
 */
export function MergeMeetingModal({ open, onClose, targetId, onMerged }: MergeMeetingModalProps) {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setError(null);
    void listMeetings()
      .then((all) => setMeetings(all.filter((m) => m.id !== targetId)))
      .catch(() => setMeetings([]));
  }, [open, targetId]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apply() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mergeMeetings(targetId, [...selected]);
      onMerged(res.transcripts_merged);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge meetings"
      description="Fold other meetings into this one. Their transcripts, notes, decisions, and action items are appended here; the originals are deleted."
      size="md"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            loading={busy}
            disabled={selected.size === 0}
            leftIcon={busy ? undefined : <GitMerge className="h-3.5 w-3.5" />}
            onClick={() => void apply()}
          >
            Merge {selected.size > 0 ? `${selected.size} ` : ''}into this
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}
      {meetings.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-zinc-400">No other meetings to merge.</p>
      ) : (
        <ul className="max-h-80 space-y-1.5 overflow-y-auto">
          {meetings.map((m) => {
            const active = selected.has(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => toggle(m.id)}
                  className={[
                    'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-all',
                    active
                      ? 'border-brand-400 bg-brand-50/40 ring-brand-200 ring-1'
                      : 'border-zinc-200 bg-white hover:border-zinc-300',
                  ].join(' ')}
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-zinc-900">
                      {m.title ?? 'Untitled meeting'}
                    </p>
                    <p className="text-[11px] text-zinc-400">
                      {new Date(m.started_at).toLocaleString()} · {m.transcript_count} segments
                    </p>
                  </div>
                  {active && (
                    <span className="bg-brand-600 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-white">
                      <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
