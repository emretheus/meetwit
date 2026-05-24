import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { deleteMeeting, listMeetings, patchMeeting, type Meeting } from '@/lib/backend';
import { useBackendReady } from '@/lib/useBackendReady';
import { useMeeting } from '@/stores/meetingStore';
import { toast } from '@/components/ToastStack';
import { Modal } from '@/components/modals/Modal';
import { Button } from '@/components/ui';

export function SidebarNotesList() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Meeting | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { ready } = useBackendReady();
  const activeMeeting = useMeeting();
  const location = useLocation();
  const navigate = useNavigate();

  function refresh() {
    void listMeetings()
      .then(setMeetings)
      .catch(() => undefined);
  }

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const fetch = () => {
      void listMeetings()
        .then((list) => {
          if (!cancelled) setMeetings(list);
        })
        .catch(() => undefined);
    };
    fetch();
    const id = window.setInterval(fetch, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ready, activeMeeting?.id, activeMeeting?.title]);

  // WKWebView's native window.confirm is unreliable (often returns false
  // silently), so we use an in-app confirm modal instead.
  function requestDelete(m: Meeting) {
    setMenuFor(null);
    setPendingDelete(m);
  }

  async function confirmDelete() {
    const m = pendingDelete;
    if (!m) return;
    setDeleting(true);
    try {
      await deleteMeeting(m.id);
      setMeetings((prev) => prev.filter((x) => x.id !== m.id));
      toast({
        title: 'Note deleted',
        description: `"${m.title ?? 'Untitled meeting'}" and its transcript were removed.`,
        tone: 'success',
        durationMs: 3000,
      });
      if (location.pathname === `/meeting/${m.id}/summary`) {
        void navigate({ to: '/' });
      }
    } catch (err) {
      toast({
        title: "Couldn't delete",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    } finally {
      setDeleting(false);
      setPendingDelete(null);
    }
  }

  function startRename(m: Meeting) {
    setMenuFor(null);
    setRenamingId(m.id);
    setRenameDraft(m.title ?? '');
  }

  async function commitRename(m: Meeting) {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (next === (m.title ?? '')) return;
    try {
      await patchMeeting(m.id, { title: next || null });
      refresh();
      toast({ title: 'Renamed', tone: 'success', durationMs: 2000 });
    } catch (err) {
      toast({
        title: "Couldn't rename",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  const top = meetings.slice(0, 8);

  const confirmModal = (
    <Modal
      open={!!pendingDelete}
      onClose={() => !deleting && setPendingDelete(null)}
      title="Delete note?"
      size="sm"
      footer={
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPendingDelete(null)}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={deleting}
            onClick={() => void confirmDelete()}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-zinc-600">
        Delete{' '}
        <span className="font-medium text-zinc-900">
          &ldquo;{pendingDelete?.title ?? 'Untitled meeting'}&rdquo;
        </span>
        ? This permanently removes its transcript, summary, decisions, and action items.
      </p>
    </Modal>
  );

  if (meetings.length === 0) return confirmModal;

  return (
    <>
      {confirmModal}
      <ul className="flex flex-col gap-px">
      {top.map((m) => {
        const isActive =
          location.pathname === `/meeting/${m.id}/summary` || activeMeeting?.id === m.id;

        if (renamingId === m.id) {
          return (
            <li key={m.id} className="px-3 py-1">
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={() => void commitRename(m)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename(m);
                  if (e.key === 'Escape') setRenamingId(null);
                }}
                className="w-full rounded-md border border-brand-400 bg-white px-1.5 py-1 text-[12.5px] text-zinc-900 focus:outline-none focus:ring-2 focus:ring-brand-100"
                placeholder="Untitled meeting"
              />
            </li>
          );
        }

        return (
          <li key={m.id} className="group/note relative">
            <Link
              to="/meeting/$id/summary"
              params={{ id: m.id }}
              className={[
                'flex items-center gap-1 rounded-lg py-2 pl-3 pr-1 text-[13px] font-medium transition-colors',
                isActive
                  ? 'bg-white text-zinc-900 shadow-xs ring-1 ring-zinc-200'
                  : 'text-zinc-600 hover:bg-white/70 hover:text-zinc-900',
              ].join(' ')}
            >
              <span className="min-w-0 flex-1 truncate">{m.title ?? 'Untitled meeting'}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuFor((cur) => (cur === m.id ? null : m.id));
                }}
                title="More"
                className={[
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 transition',
                  'hover:bg-zinc-200/70 hover:text-zinc-700',
                  menuFor === m.id ? 'opacity-100' : 'opacity-0 group-hover/note:opacity-100',
                ].join(' ')}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </Link>

            {menuFor === m.id && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  aria-hidden="true"
                  onClick={() => setMenuFor(null)}
                />
                <div className="absolute right-1 top-8 z-20 w-36 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg ring-1 ring-black/5">
                  <button
                    type="button"
                    onClick={() => startRename(m)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-zinc-700 transition hover:bg-zinc-50"
                  >
                    <Pencil className="h-3.5 w-3.5 text-zinc-500" />
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => requestDelete(m)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-red-600 transition hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
                  </button>
                </div>
              </>
            )}
          </li>
        );
      })}
      </ul>
    </>
  );
}
