import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface TwoPaneSplitterProps {
  /** Storage key for persisting the ratio. */
  storageKey?: string;
  /** Default left-pane ratio 0..1. */
  defaultRatio?: number;
  /** Min ratio (left). */
  min?: number;
  /** Max ratio (left). */
  max?: number;
  left: ReactNode;
  right: ReactNode;
}

export function TwoPaneSplitter({
  storageKey,
  defaultRatio = 0.55,
  min = 0.3,
  max = 0.75,
  left,
  right,
}: TwoPaneSplitterProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const [ratio, setRatio] = useState(() => {
    if (!storageKey) return defaultRatio;
    const stored = localStorage.getItem(storageKey);
    if (!stored) return defaultRatio;
    const n = Number(stored);
    return Number.isFinite(n) && n > min && n < max ? n : defaultRatio;
  });

  useEffect(() => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, String(ratio));
  }, [storageKey, ratio]);

  const onMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      setRatio(Math.max(min, Math.min(max, pct)));
    },
    [min, max],
  );

  const stopDrag = useCallback(() => {
    draggingRef.current = false;
    document.body.style.removeProperty('cursor');
    document.body.style.removeProperty('user-select');
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => onMouseMove(e);
    const up = () => stopDrag();
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [onMouseMove, stopDrag]);

  function startDrag() {
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      <div style={{ flex: `${ratio} 1 0%` }} className="flex min-w-0 flex-col">
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startDrag}
        onDoubleClick={() => setRatio(defaultRatio)}
        className="group relative w-px shrink-0 cursor-col-resize bg-zinc-200 transition-colors hover:bg-brand-400"
        title="Drag to resize · Double-click to reset"
      >
        <span className="absolute inset-y-0 -left-1 -right-1" />
      </div>
      <div style={{ flex: `${1 - ratio} 1 0%` }} className="flex min-w-0 flex-col">
        {right}
      </div>
    </div>
  );
}
