import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onPtyData, onPtyExit, ptyKill, ptyResize, ptySpawn, ptyWrite } from '@/lib/tauri';

/**
 * The "Claude Code" tab: a real terminal (xterm.js) bound to a PTY in the Rust
 * core. On mount it spawns the user's shell and (when `autoClaude`) bootstraps
 * Claude Code with the Meetwit MCP server, so the user can query this meeting's
 * data with their own Claude subscription. Closing the tab kills the PTY.
 */
export function TerminalPanel({ autoClaude = true }: { autoClaude?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let sessionId: string | null = null;
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const term = new Terminal({
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      cursorBlink: true,
      // A calm dark theme that fits the app; xterm needs explicit colors.
      theme: {
        background: '#0b1220',
        foreground: '#e2e8f0',
        cursor: '#60a5fa',
        selectionBackground: '#1d4ed8',
      },
      // Let scrollback live in xterm; the shell handles its own paging.
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    void (async () => {
      sessionId = await ptySpawn(term.cols, term.rows, autoClaude);
      if (disposed) {
        void ptyKill(sessionId);
        return;
      }
      // PTY output → terminal.
      unlistenData = await onPtyData((e) => {
        if (e.session_id === sessionId) term.write(e.data);
      });
      // Shell exited → tell the user (the tab can be reopened to restart).
      unlistenExit = await onPtyExit((sid) => {
        if (sid === sessionId) term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      });
      // Keystrokes / paste → PTY.
      term.onData((data) => {
        if (sessionId) void ptyWrite(sessionId, data);
      });
    })();

    // Keep the PTY sized to the panel.
    resizeObserver = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* host detached mid-resize */
      }
      if (sessionId) void ptyResize(sessionId, term.cols, term.rows);
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (sessionId) void ptyKill(sessionId);
      term.dispose();
    };
  }, [autoClaude]);

  return (
    <div className="flex h-full flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden bg-[#0b1220] p-2" />
    </div>
  );
}
