import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type Size = 'xs' | 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-brand-600 text-white shadow-xs hover:bg-brand-700 active:bg-brand-800 ' +
    'disabled:bg-brand-300 disabled:shadow-none ' +
    'focus-visible:ring-brand-500/30',
  secondary:
    'bg-white text-zinc-900 border border-zinc-200 shadow-xs ' +
    'hover:bg-zinc-50 hover:border-zinc-300 ' +
    'active:bg-zinc-100 ' +
    'disabled:opacity-50 disabled:shadow-none ' +
    'focus-visible:ring-zinc-300/60',
  ghost:
    'bg-transparent text-zinc-600 ' +
    'hover:text-zinc-900 hover:bg-zinc-100 ' +
    'active:bg-zinc-200 ' +
    'disabled:opacity-40 ' +
    'focus-visible:ring-zinc-300/60',
  subtle:
    'bg-zinc-100 text-zinc-700 ' +
    'hover:bg-zinc-200 hover:text-zinc-900 ' +
    'disabled:opacity-50 ' +
    'focus-visible:ring-zinc-300/60',
  danger:
    'bg-red-600 text-white shadow-xs hover:bg-red-700 active:bg-red-800 ' +
    'disabled:bg-red-300 disabled:shadow-none ' +
    'focus-visible:ring-red-400/30',
};

const sizes: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded-md',
  sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    className = '',
    children,
    disabled,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={[
        'inline-flex shrink-0 items-center justify-center font-medium tracking-tight whitespace-nowrap',
        'transition-[background,color,border,box-shadow] duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-white',
        'disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        fullWidth ? 'w-full' : '',
        className,
      ].join(' ')}
      {...rest}
    >
      {loading ? (
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
