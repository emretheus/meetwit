import { ChevronDown } from 'lucide-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';

type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  /** Optional left-side adornment (icon). */
  leftIcon?: React.ReactNode;
};

/**
 * Styled native select. We force `appearance: none` to strip macOS Tauri's
 * inset-shadow chrome and double-arrow, then render our own chevron on the
 * right. Keeps the keyboard accessibility + native open-on-click behavior.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', leftIcon, children, ...rest }, ref) => {
    return (
      <div className="relative">
        {leftIcon && (
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500">
            {leftIcon}
          </span>
        )}
        <select
          ref={ref}
          {...rest}
          className={[
            // Strip native appearance — covers macOS/iOS/Windows quirks.
            'appearance-none [-webkit-appearance:none] [-moz-appearance:none]',
            'w-full rounded-lg border border-zinc-200 bg-white text-[13px] text-zinc-800 shadow-xs',
            'transition-colors focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100',
            'disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-400',
            // Padding accommodates icon (left) and chevron (right).
            leftIcon ? 'pl-8' : 'pl-3',
            'pr-8 py-1.5',
            className,
          ].join(' ')}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400"
          strokeWidth={2.25}
        />
      </div>
    );
  },
);
Select.displayName = 'Select';
