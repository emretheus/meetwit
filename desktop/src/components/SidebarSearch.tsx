import { Search } from 'lucide-react';

interface SidebarSearchProps {
  onOpen: () => void;
}

export function SidebarSearch({ onOpen }: SidebarSearchProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-center gap-2 rounded-full bg-white px-3.5 py-2 text-left text-[12.5px] text-zinc-500 ring-1 ring-inset ring-[var(--color-sidebar-border)] transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/30"
    >
      <Search className="h-3.5 w-3.5 text-zinc-400 transition-colors group-hover:text-zinc-600" />
      <span className="flex-1 truncate">Search meeting content…</span>
      <kbd className="hidden shrink-0 items-center rounded border border-zinc-200 bg-white px-1 font-mono text-[9.5px] text-zinc-500 sm:inline-flex">
        ⌘K
      </kbd>
    </button>
  );
}
