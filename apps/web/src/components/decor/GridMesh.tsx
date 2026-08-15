import { cn } from '../../lib/utils.js';

/**
 * A faint technical grid, faded out towards the edges by a radial mask.
 *
 * Two repeating linear gradients rather than an SVG pattern or a tiled image —
 * it is a handful of bytes, scales to any viewport, and picks up the theme
 * colour automatically.
 */
export function GridMesh({
  className,
  size = 32,
  fade = 'radial',
}: {
  className?: string;
  /** Cell size in pixels. */
  size?: number;
  fade?: 'radial' | 'top' | 'none';
}) {
  const mask =
    fade === 'radial'
      ? 'radial-gradient(ellipse 70% 60% at 50% 40%, #000 40%, transparent 100%)'
      : fade === 'top'
        ? 'linear-gradient(to bottom, #000, transparent)'
        : undefined;

  return (
    <div
      aria-hidden
      className={cn('pointer-events-none absolute inset-0', className)}
      style={{
        backgroundImage:
          'repeating-linear-gradient(to right, var(--color-border) 0 1px, transparent 1px 100%),' +
          'repeating-linear-gradient(to bottom, var(--color-border) 0 1px, transparent 1px 100%)',
        backgroundSize: `${size}px ${size}px`,
        opacity: 0.5,
        ...(mask ? { maskImage: mask, WebkitMaskImage: mask } : {}),
      }}
    />
  );
}
