import type { HTMLAttributes, ReactNode } from 'react';

type Color = 'neutral' | 'success' | 'danger' | 'warning' | 'info' | 'recording' | 'brand';
type Size = 'xs' | 'sm';

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  color?: Color;
  icon?: ReactNode;
  size?: Size;
  dot?: boolean;
}

const colors: Record<Color, string> = {
  neutral: 'bg-zinc-100 text-zinc-700 ring-zinc-200/60',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200/60',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-200/60',
  danger: 'bg-red-50 text-red-700 ring-red-200/60',
  warning: 'bg-amber-50 text-amber-800 ring-amber-200/60',
  info: 'bg-sky-50 text-sky-700 ring-sky-200/60',
  recording: 'bg-orange-50 text-orange-700 ring-orange-200/60',
};

const dotColors: Record<Color, string> = {
  neutral: 'bg-zinc-400',
  brand: 'bg-brand-500',
  success: 'bg-emerald-500',
  danger: 'bg-red-500',
  warning: 'bg-amber-500',
  info: 'bg-sky-500',
  recording: 'bg-orange-500',
};

const sizes: Record<Size, string> = {
  xs: 'h-4 px-1.5 text-[10px] gap-1 rounded',
  sm: 'h-5 px-2 text-[11px] gap-1 rounded-md',
};

export function Badge({
  color = 'neutral',
  icon,
  size = 'sm',
  dot = false,
  className = '',
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={[
        'inline-flex items-center font-medium tracking-tight ring-1',
        colors[color],
        sizes[size],
        className,
      ].join(' ')}
      {...rest}
    >
      {dot && (
        <span
          className={[
            'h-1.5 w-1.5 shrink-0 rounded-full',
            dotColors[color],
            color === 'recording' ? 'recording-dot' : '',
          ].join(' ')}
        />
      )}
      {icon}
      {children}
    </span>
  );
}
