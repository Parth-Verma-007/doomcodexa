import { cn } from '../../lib/utils.js';

/**
 * Soft coloured bloom behind a hero section.
 *
 * Three offset radial gradients on a very slow drift. Implemented as plain CSS
 * rather than a WebGL plane: it costs nothing on the landing page's critical
 * path, composites on the GPU, and degrades to a static gradient under
 * `prefers-reduced-motion` (handled globally in index.css).
 */
export function GradientBloom({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
    >
      <div className="codexa-bloom codexa-bloom-a" />
      <div className="codexa-bloom codexa-bloom-b" />
      <div className="codexa-bloom codexa-bloom-c" />
    </div>
  );
}
