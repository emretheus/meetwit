import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  /** Lower visual weight — useful for nested cards. */
  flat?: boolean;
  /** Tighter padding density for dense lists. */
  dense?: boolean;
}

export function Card({
  padded = true,
  header,
  footer,
  flat = false,
  dense = false,
  className = '',
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={[
        'rounded-xl bg-white',
        flat ? 'border border-zinc-200/80' : 'border border-zinc-200 shadow-xs',
        className,
      ].join(' ')}
      {...rest}
    >
      {header && (
        <div className={['border-b border-zinc-100', dense ? 'px-4 py-2.5' : 'px-5 py-3'].join(' ')}>
          {header}
        </div>
      )}
      <div className={padded ? (dense ? 'px-4 py-3' : 'px-5 py-4') : ''}>{children}</div>
      {footer && (
        <div className={['border-t border-zinc-100 bg-zinc-50/40', dense ? 'px-4 py-2.5' : 'px-5 py-3'].join(' ')}>
          {footer}
        </div>
      )}
    </div>
  );
}
