import { cn } from '../../lib/utils.js';

/**
 * A blur that ramps up towards one edge, instead of a hard blur boundary.
 *
 * A single `backdrop-filter` produces a visible seam where it stops. Stacking
 * several layers, each blurring more and each masked to a narrower band, makes
 * the transition continuous — content slides under it and dissolves rather than
 * hitting a line.
 *
 * Used where scrollable content meets a chrome edge.
 */
export function ProgressiveBlur({
  side = 'bottom',
  height = 96,
  layers = 5,
  className,
}: {
  side?: 'top' | 'bottom';
  height?: number;
  layers?: number;
  className?: string;
}) {
  const toEdge = side === 'bottom' ? 'to top' : 'to bottom';

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-x-0 z-10',
        side === 'bottom' ? 'bottom-0' : 'top-0',
        className,
      )}
      style={{ height }}
    >
      {Array.from({ length: layers }, (_, index) => {
        const step = (index + 1) / layers;
        // Each layer covers a progressively smaller band nearest the edge, so
        // the blur radius the eye sees ramps smoothly across the whole height.
        const start = (index / layers) * 100;
        const mid = start + (100 / layers) * 0.5;
        const mask = `linear-gradient(${toEdge}, transparent ${start}%, #000 ${mid}%)`;

        return (
          <div
            key={index}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${step * step * 12}px)`,
              WebkitBackdropFilter: `blur(${step * step * 12}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        );
      })}
    </div>
  );
}
