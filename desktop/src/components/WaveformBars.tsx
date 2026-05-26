import { useEffect, useRef, useState } from 'react';
import { mixerStatus } from '@/lib/tauri';
import { useRunning } from '@/stores/meetingStore';

interface WaveformBarsProps {
  size?: 'sm' | 'md';
  /** Pause polling when off-screen / collapsed. */
  active?: boolean;
}

/**
 * Three animated bars driven by the mixer RMS. Polls `mixerStatus` every
 * 120ms — cheap, sub-percent CPU. Each bar gets a per-bar smoothing so they
 * don't all march in lock-step.
 */
export function WaveformBars({ size = 'md', active = true }: WaveformBarsProps) {
  const running = useRunning();
  const [levels, setLevels] = useState<[number, number, number]>([0.15, 0.25, 0.15]);
  const phase = useRef(0);

  useEffect(() => {
    if (!running || !active) {
      setLevels([0.15, 0.2, 0.15]);
      return;
    }
    let cancelled = false;
    const id = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const status = await mixerStatus();
        const rms = status?.stats?.last_mix_rms ?? 0;
        // Map RMS [0, ~0.4] → [0.15, 1.0] with a soft knee.
        const norm = Math.min(1, Math.max(0.15, rms * 4 + 0.1));
        phase.current = (phase.current + 1) % 3;
        setLevels((prev) => {
          const next: [number, number, number] = [...prev];
          // Decay all bars a touch, then bump one bar to the new amplitude.
          for (let i = 0; i < 3; i += 1) next[i] = Math.max(0.15, next[i]! * 0.78);
          // Offset side bars a bit lower so they read as side companions.
          const idx = phase.current;
          next[idx] = norm * (idx === 1 ? 1 : 0.78);
          return next;
        });
      } catch {
        /* mixer not running yet; keep prior levels */
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [running, active]);

  const w = size === 'sm' ? 2 : 2.5;
  const gap = size === 'sm' ? 2 : 3;
  const maxH = size === 'sm' ? 14 : 18;

  return (
    <span
      className="inline-flex items-end"
      style={{ gap, height: maxH }}
      aria-hidden="true"
    >
      {levels.map((lvl, i) => (
        <span
          key={i}
          className={[
            'rounded-full',
            running ? 'bg-orange-500' : 'bg-zinc-300',
          ].join(' ')}
          style={{
            width: w,
            height: Math.max(2, lvl * maxH),
            transition: 'height 160ms ease-out',
          }}
        />
      ))}
    </span>
  );
}
