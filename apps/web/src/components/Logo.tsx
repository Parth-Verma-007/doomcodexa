import { useId } from 'react';
import { cn } from '../lib/utils.js';

/**
 * The mark, as one path with an even-odd counter.
 *
 * A square inset 2 in a 24 box — the same 20/24 glyph area lucide uses, so it
 * carries the visual weight of the icon it replaced at the same `size`. Two
 * opposite corners are rounded to the full half-width and two are left sharp,
 * which is what gives the leaf its point at the bottom left. The counter is the
 * same shape at 12/20, pinned 3.2 from the top and right edges rather than
 * centred — that is what thins the band along the top and swells it into the
 * solid wedge at the point.
 */
const MARK =
  'M22 2 L12 2 A10 10 0 0 0 2 12 L2 22 L12 22 A10 10 0 0 0 22 12 Z ' +
  'M18.8 5.2 L12.8 5.2 A6 6 0 0 0 6.8 11.2 L6.8 17.2 L12.8 17.2 A6 6 0 0 0 18.8 11.2 Z';

/**
 * The Codexa mark.
 *
 * Drawn rather than shipped as an image, for the same reasons the rest of this
 * page's furniture is: it stays sharp at any density, weighs nothing on the
 * landing page's critical path, and — the part an exported PNG cannot do — the
 * gradient starts at `--color-accent`, so the logo shifts with the theme
 * instead of sitting on it. The violet end is the same `#9c6bff` the hero
 * heading runs through, which is what ties the two together.
 *
 * Always `aria-hidden`: every place this appears, the word "Codexa" is set
 * beside it, and labelling the mark too would have a screen reader say it
 * twice.
 */
export function Logo({ size = 18, className }: { size?: number; className?: string }) {
  // Without this, two marks on one page would share a gradient id and the
  // second would be painted with the first one's stops.
  const gradientId = `codexa-mark-${useId().replace(/:/g, '')}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--color-accent)" />
          <stop offset="1" stopColor="#9c6bff" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradientId})`} fillRule="evenodd" d={MARK} />
    </svg>
  );
}
