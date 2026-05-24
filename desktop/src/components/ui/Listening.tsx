interface ListeningProps {
  label?: string;
  className?: string;
}

export function Listening({ label = 'Listening', className = '' }: ListeningProps) {
  return (
    <div className={['flex items-center gap-2 text-zinc-400', className].join(' ')}>
      <span className="text-[11px] font-medium tracking-wide uppercase">{label}</span>
      <span className="flex items-end gap-0.5" aria-hidden="true">
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-300 [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-300 [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-300" />
      </span>
    </div>
  );
}
