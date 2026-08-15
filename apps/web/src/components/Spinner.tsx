import { cn } from '../lib/utils.js';

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 text-ink-muted', className)} role="status">
      <span
        aria-hidden
        className="size-4 animate-spin rounded-full border-2 border-border-strong border-t-accent"
      />
      {label ? <span className="text-sm">{label}…</span> : null}
      <span className="sr-only">{label ?? 'Loading'}</span>
    </div>
  );
}
