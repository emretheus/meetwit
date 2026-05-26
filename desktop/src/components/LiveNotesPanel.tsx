import { useCallback, useEffect, useRef, useState } from 'react';
import { NotebookPen, Trash2 } from 'lucide-react';
import { createNote, deleteNote, listNotes, type NoteOut } from '@/lib/backend';
import { Button, Textarea } from '@/components/ui';
import { formatTime } from '@/lib/transcript';
import { toast } from '@/components/ToastStack';

interface LiveNotesPanelProps {
  meetingId: string | null;
  /** Current elapsed seconds, used to pin a note to the timeline. Null = unknown. */
  elapsedSeconds: number | null;
}

/**
 * Manual notes taken during a live meeting (#389). Notes are time-stamped to
 * the recording timeline and persisted immediately, so they survive reloads
 * and flow into the export + summary context.
 */
export function LiveNotesPanel({ meetingId, elapsedSeconds }: LiveNotesPanelProps) {
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (!meetingId) return;
    void listNotes(meetingId)
      .then(setNotes)
      .catch(() => undefined);
  }, [meetingId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [notes.length]);

  async function add() {
    const text = draft.trim();
    if (!text || !meetingId || saving) return;
    setSaving(true);
    try {
      const note = await createNote(meetingId, {
        text,
        ...(elapsedSeconds !== null ? { audio_offset: Math.max(0, elapsedSeconds) } : {}),
      });
      setNotes((prev) => [...prev, note]);
      setDraft('');
    } catch (err) {
      toast({
        title: 'Could not save note',
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: number) {
    try {
      await deleteNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch {
      /* keep it on failure */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-4">
        {notes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-zinc-400">
            <NotebookPen className="h-5 w-5" />
            <p className="text-[12px]">
              No notes yet. Jot anything below — it&rsquo;s timestamped.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className="group flex items-start gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2"
              >
                {n.audio_offset !== null && (
                  <span className="mt-0.5 shrink-0 rounded-md bg-zinc-100 px-1.5 font-mono text-[10px] tabular-nums text-zinc-500">
                    {formatTime(n.audio_offset)}
                  </span>
                )}
                <span className="min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-relaxed text-zinc-800">
                  {n.text}
                </span>
                <button
                  type="button"
                  onClick={() => void remove(n.id)}
                  className="shrink-0 text-zinc-300 opacity-0 transition hover:text-red-500 group-hover:opacity-100"
                  title="Delete note"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div ref={listEndRef} />
      </div>

      <div className="border-t border-zinc-200 p-3">
        <Textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter to add — Enter alone keeps newlines for longer notes.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="Type a note…  (⌘↵ to add)"
          disabled={!meetingId}
          className="text-[13px]"
        />
        <div className="mt-2 flex justify-end">
          <Button size="sm" onClick={() => void add()} loading={saving} disabled={!draft.trim()}>
            Add note
          </Button>
        </div>
      </div>
    </div>
  );
}
