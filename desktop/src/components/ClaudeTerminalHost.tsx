import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useClaudeEverOpened, useMeetingStore } from '@/stores/meetingStore';
import { TerminalPanel } from '@/components/TerminalPanel';

/**
 * App-level host for the single embedded "Claude Code" terminal.
 *
 * Mounted once in the root layout (next to RecordingPill) so it OUTLIVES route
 * changes. `<TerminalPanel>` is rendered (via a portal) into ONE stable
 * container `<div>` that is created once. That container is re-parented between:
 *   - a hidden off-screen "parking" spot (when the Claude tab isn't visible), and
 *   - the right-panel `<ClaudeTerminalSlot>` (when the tab is active),
 * by `<ClaudeTerminalSlot>` calling `appendChild`. Because the container node and
 * the React `<TerminalPanel>` inside it are never unmounted — only re-parented —
 * the live `claude` PTY session + scrollback survive tab AND route changes.
 */

// The single stable container the terminal lives in. Created on first open.
let container: HTMLDivElement | null = null;
// The off-screen parking element (set by the host); the slot returns the
// container here directly on unmount so the node never becomes orphaned.
let parkEl: HTMLElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (!container) {
    container = document.createElement('div');
    container.style.height = '100%';
    container.style.width = '100%';
  }
  return container;
}

/** Move the terminal container into `parent` (no-op if already there). */
function adopt(parent: HTMLElement): void {
  const c = ensureContainer();
  if (c.parentElement !== parent) parent.appendChild(c);
}

export function ClaudeTerminalHost() {
  const everOpened = useClaudeEverOpened();
  const parkRef = useRef<HTMLDivElement | null>(null);
  // Bind to the active recording meeting ONCE (first open) so browsing other
  // pages mid-recording never respawns the session.
  const [bound, setBound] = useState<{ id: string | null; title: string | null } | null>(null);

  useEffect(() => {
    if (everOpened && bound === null) {
      const m = useMeetingStore.getState().meeting;
      setBound({ id: m?.id ?? null, title: m?.title ?? null });
    }
    if (!everOpened && bound !== null) setBound(null);
  }, [everOpened, bound]);

  // Publish the parking element + park the container in it initially. The slot
  // returns the container here directly on unmount (see ClaudeTerminalSlot), so
  // the node is never orphaned between a tab/route switch.
  useEffect(() => {
    parkEl = parkRef.current;
    if (everOpened && parkEl) {
      const c = ensureContainer();
      if (c.parentElement === null) parkEl.appendChild(c);
    }
    return () => {
      parkEl = null;
    };
  }, [everOpened]);

  if (!everOpened || bound === null) return null;

  return (
    <>
      {/* Off-screen parking spot — keeps the terminal node alive (in the DOM, so
          xterm keeps measuring) when the Claude tab isn't on screen. */}
      <div
        ref={parkRef}
        aria-hidden="true"
        style={{ position: 'fixed', left: '-99999px', top: 0, width: '440px', height: '600px' }}
      />
      {/* Render TerminalPanel into the stable container via a portal. */}
      {createPortal(
        <TerminalPanel autoClaude meetingId={bound.id} meetingTitle={bound.title} />,
        ensureContainer(),
      )}
    </>
  );
}

/**
 * Drop-in for the right panel: when mounted (Claude tab active), it pulls the
 * shared terminal container into view; on unmount the host re-parks it.
 */
export function ClaudeTerminalSlot() {
  const slotRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = slotRef.current;
    if (el) adopt(el);
    // On unmount (tab away / route change), return the container straight to the
    // hidden parking spot so the terminal node (and its PTY) stays alive.
    return () => {
      if (parkEl) adopt(parkEl);
    };
  }, []);
  return <div ref={slotRef} className="min-h-0 flex-1" />;
}
