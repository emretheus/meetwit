interface SpinnerProps {
  size?: number;
  className?: string;
  /** Stroke color via Tailwind class (e.g. "text-zinc-500"). Defaults to current. */
  tone?: string;
}

/**
 * Small inline spinner. Bordered ring with a transparent top edge — readable
 * over light AND dark backgrounds because the border picks up `currentColor`.
 */
export function Spinner({ size = 14, className = '', tone = 'text-current' }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="loading"
      className={['inline-block animate-spin rounded-full border-2 border-current border-t-transparent', tone, className].join(' ')}
      style={{ width: size, height: size }}
    />
  );
}
