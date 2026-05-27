import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { TerminalSquare } from 'lucide-react';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { onPtyData, onPtyExit, ptyKill, ptyResize, ptySpawn, ptyWrite } from '@/lib/tauri';

/**
 * Light terminal theme that matches the app's surface (white/zinc) rather than
 * a generic dark terminal. The ANSI 16-colour palette is tuned for a light
 * background so Claude Code's coloured output stays legible.
 */
const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#27272a', // zinc-800
  cursor: '#2563eb', // brand-600
  cursorAccent: '#ffffff',
  selectionBackground: '#bfdbfe', // brand-200
  selectionForeground: '#1e293b',
  // Standard ANSI — darkened where needed for contrast on white.
  black: '#3f3f46',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#b45309',
  blue: '#2563eb',
  magenta: '#9333ea',
  cyan: '#0891b2',
  white: '#52525b',
  brightBlack: '#71717a',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#d97706',
  brightBlue: '#3b82f6',
  brightMagenta: '#a855f7',
  brightCyan: '#06b6d4',
  brightWhite: '#27272a',
};

/**
 * The "Claude Code" tab: a real terminal (xterm.js) bound to a PTY in the Rust
 * core. On mount it spawns the user's shell and (when `autoClaude`) bootstraps
 * Claude Code with the Meetwit MCP server, so the user can query this meeting's
 * data with their own Claude subscription. Closing the tab kills the PTY.
 */
export function TerminalPanel({ autoClaude = true }: { autoClaude?: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Guards against React 18 StrictMode double-invoking the effect in dev (which
  // otherwise spawns two PTYs). The cleanup resets it.
  const startedRef = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || startedRef.current) return;
    startedRef.current = true;

    let disposed = false;
    let sessionId: string | null = null;
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const term = new Terminal({
      fontSize: 12.5,
      lineHeight: 1.2,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      cursorBlink: true,
      theme: LIGHT_THEME,
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
      unlistenData = await onPtyData((e) => {
        if (e.session_id === sessionId) term.write(e.data);
      });
      unlistenExit = await onPtyExit((sid) => {
        if (sid === sessionId) term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      });
      term.onData((data) => {
        if (sessionId) void ptyWrite(sessionId, data);
      });
    })();

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
      startedRef.current = false;
      resizeObserver?.disconnect();
      unlistenData?.();
      unlistenExit?.();
      if (sessionId) void ptyKill(sessionId);
      term.dispose();
    };
  }, [autoClaude]);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-zinc-100 px-3 py-1.5 text-[11px] font-medium text-zinc-500">
        <TerminalSquare className="h-3.5 w-3.5 text-zinc-400" />
        Claude Code
        <span className="text-zinc-300">·</span>
        <span className="text-zinc-400">your subscription, on-device</span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-3 py-2" />
    </div>
  );
}
