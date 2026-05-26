import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import {
  createFolder,
  deleteMeeting,
  listFolders,
  listMeetings,
  moveMeetingToFolder,
  patchMeeting,
  type FolderOut,
  type Meeting,
} from '@/lib/backend';
import { useBackendReady } from '@/lib/useBackendReady';
import { useMeeting } from '@/stores/meetingStore';
import { toast } from '@/components/ToastStack';
import { Modal } from '@/components/modals/Modal';
import { Button } from '@/components/ui';

const COLLAPSED_KEY = 'meetwit:sidebar:collapsedFolders';

export function SidebarNotesList() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [folders, setFolders] = useState<FolderOut[]>([]);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<Meeting | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState<Meeting | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const { ready } = useBackendReady();
  const activeMeeting = useMeeting();
  const location = useLocation();
  const navigate = useNavigate();

  function refresh() {
    void listMeetings()
      .then(setMeetings)
      .catch(() => undefined);
    void listFolders()
      .then(setFolders)
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
      void listFolders()
        .then((f) => {
          if (!cancelled) setFolders(f);
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

  function toggleCollapse(folderId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  // WKWebView's native window.confirm is unreliable, so we use a modal.
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

  async function moveTo(m: Meeting, folderId: string | null) {
    setMoveFor(null);
    try {
      await moveMeetingToFolder(m.id, folderId);
      refresh();
      toast({ title: 'Moved', tone: 'success', durationMs: 1800 });
    } catch (err) {
      toast({
        title: "Couldn't move",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

  async function addFolder() {
    const name = renameDraft.trim() || 'New folder';
    try {
      await createFolder(name);
      setRenameDraft('');
      refresh();
    } catch (err) {
      toast({
        title: "Couldn't create folder",
        description: err instanceof Error ? err.message : String(err),
        tone: 'error',
      });
    }
  }

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

  const moveModal = (
    <Modal open={!!moveFor} onClose={() => setMoveFor(null)} title="Move to folder" size="sm">
      <ul className="space-y-1">
        <li>
          <button
            type="button"
            onClick={() => moveFor && void moveTo(moveFor, null)}
            className="w-full rounded-lg px-3 py-2 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-100"
          >
            No folder (root)
          </button>
        </li>
        {folders.map((f) => (
          <li key={f.id}>
            <button
              type="button"
              onClick={() => moveFor && void moveTo(moveFor, f.id)}
              className="w-full rounded-lg px-3 py-2 text-left text-[13px] text-zinc-700 transition hover:bg-zinc-100"
            >
              {f.name}
            </button>
          </li>
        ))}
        {folders.length === 0 && (
          <li className="px-3 py-2 text-[12px] text-zinc-400">
            No folders yet — create one with the + above.
          </li>
        )}
      </ul>
    </Modal>
  );

  function renderMeeting(m: Meeting) {
    const isActive = location.pathname === `/meeting/${m.id}/summary` || activeMeeting?.id === m.id;

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
            className="border-brand-400 focus:ring-brand-100 w-full rounded-md border bg-white px-1.5 py-1 text-[12.5px] text-zinc-900 focus:outline-none focus:ring-2"
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
              ? 'shadow-xs bg-white text-zinc-900 ring-1 ring-zinc-200'
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
            <div className="absolute right-1 top-8 z-20 w-40 overflow-hidden rounded-lg border border-zinc-200 bg-white py-1 shadow-lg ring-1 ring-black/5">
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
                onClick={() => {
                  setMenuFor(null);
                  setMoveFor(m);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-zinc-700 transition hover:bg-zinc-50"
              >
                <FolderPlus className="h-3.5 w-3.5 text-zinc-500" />
                Move to folder…
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
  }

  if (meetings.length === 0 && folders.length === 0) {
    return (
      <>
        {confirmModal}
        {moveModal}
      </>
    );
  }

  // Group: each folder (with its meetings), then ungrouped (root) meetings.
  const byFolder = new Map<string, Meeting[]>();
  const root: Meeting[] = [];
  for (const m of meetings) {
    if (m.folder_id) {
      const arr = byFolder.get(m.folder_id) ?? [];
      arr.push(m);
      byFolder.set(m.folder_id, arr);
    } else {
      root.push(m);
    }
  }

  return (
    <>
      {confirmModal}
      {moveModal}

      {folders.length > 0 && (
        <div className="mb-1 flex items-center justify-between px-3">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
            Folders
          </span>
          <button
            type="button"
            onClick={() => void addFolder()}
            title="New folder"
            className="flex h-5 w-5 items-center justify-center rounded text-zinc-400 transition hover:bg-zinc-200/70 hover:text-zinc-700"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {folders.map((f) => {
        const items = byFolder.get(f.id) ?? [];
        const isCollapsed = collapsed.has(f.id);
        return (
          <div key={f.id} className="mb-1">
            <button
              type="button"
              onClick={() => toggleCollapse(f.id)}
              className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-zinc-600 transition hover:bg-white/70"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
              )}
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-[10px] tabular-nums text-zinc-400">{items.length}</span>
            </button>
            {!isCollapsed && items.length > 0 && (
              <ul className="ml-2 flex flex-col gap-px border-l border-zinc-200 pl-1">
                {items.map(renderMeeting)}
              </ul>
            )}
          </div>
        );
      })}

      {root.length > 0 && (
        <ul className="flex flex-col gap-px">{root.slice(0, 12).map(renderMeeting)}</ul>
      )}

      {folders.length === 0 && (
        <button
          type="button"
          onClick={() => void addFolder()}
          className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] text-zinc-400 transition hover:bg-white/70 hover:text-zinc-600"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New folder
        </button>
      )}
    </>
  );
}
