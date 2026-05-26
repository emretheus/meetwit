import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

const base =
  'block w-full rounded-md border bg-white px-3 py-1.5 text-[13px] text-zinc-900 placeholder:text-zinc-400 ' +
  'transition-[border-color,box-shadow] duration-150 ' +
  'focus:outline-none focus:ring-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-zinc-50';

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, className = '', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={[
        base,
        invalid
          ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
          : 'border-zinc-200 focus:border-brand-500 focus:ring-brand-100',
        className,
      ].join(' ')}
      {...rest}
    />
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className = '', ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={[
        base,
        'resize-none leading-relaxed',
        invalid
          ? 'border-red-300 focus:border-red-400 focus:ring-red-100'
          : 'border-zinc-200 focus:border-brand-500 focus:ring-brand-100',
        className,
      ].join(' ')}
      {...rest}
    />
  );
});
