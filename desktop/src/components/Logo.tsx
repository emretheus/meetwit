interface LogoProps {
  /** Pixel size of the square chip. */
  size?: number;
  className?: string;
  /** Render just the glyph (no chip background) — for tinted surfaces. */
  bare?: boolean;
}

/**
 * Meetwit mark — a bold "M" stroke that doubles as a soundwave: the letter's
 * two peaks + center valley read as audio amplitude, and two short "echo"
 * bars flank it so it's recognizable as a waveform, not just a glyph. White
 * on a rounded deep-blue chip.
 *
 * Self-contained SVG — scales crisply from favicon to hero, no asset pipeline.
 */
export function Logo({ size = 28, className = '', bare = false }: LogoProps) {
  const gid = 'meetwit-logo-grad';
  const stroke = bare ? `url(#${gid})` : '#ffffff';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Meetwit"
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3b82f6" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
      </defs>
      {!bare && <rect width="32" height="32" rx="8" fill={`url(#${gid})`} />}

      {/* The "M" stroke — left leg up to peak, down to center valley, up to
          peak, down right leg. Rounded joins/caps give it a soundwave feel. */}
      <path
        d="M9 22.5 L9 11 L16 17.5 L23 11 L23 22.5"
        stroke={stroke}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Flanking echo bars — make it read as a waveform. */}
      <rect x="4.7" y="14" width="2.4" height="6" rx="1.2" fill={stroke} />
      <rect x="24.9" y="14" width="2.4" height="6" rx="1.2" fill={stroke} />
    </svg>
  );
}
