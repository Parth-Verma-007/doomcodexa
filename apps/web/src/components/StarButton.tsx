import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/utils.js';

/**
 * The four-point sparkle, drawn once. Six copies fly out of the button on
 * hover, so the path lives here rather than being repeated in the markup.
 */
const STAR_PATH =
  'M392.05 0c-20.9,210.08 -184.06,378.41 -392.05,407.78 207.96,29.37 371.12,197.68 392.05,407.74 ' +
  '20.93,-210.06 184.09,-378.37 392.06,-407.74 -207.97,-29.37 -371.12,-197.7 -392.06,-407.78z';

const STARS = [1, 2, 3, 4, 5, 6] as const;

/**
 * The landing page's "Start coding free" button.
 *
 * A filled accent button that inverts to an outline on hover, throwing six
 * sparkles out as it does. Sizing, weight and radius match `<Button size="lg">`
 * so it lines up with the button standing beside it; the colours and the
 * choreography live in `.codexa-star-button` in index.css, where the hover
 * positions are easier to read as a set.
 *
 * Deliberately not built as a `<Button variant>`: the effect needs six extra
 * children and must not be combined with `sheen`, whose `overflow: hidden`
 * would clip the sparkles at the button's edge.
 */
export const StarButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function StarButton({ children, className, ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          'codexa-star-button relative inline-flex items-center justify-center',
          'h-11 gap-2 rounded-lg px-6 text-base font-medium',
          'active:translate-y-px',
          'disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0',
          className,
        )}
        {...props}
      >
        {children}
        {STARS.map((n) => (
          <svg
            key={n}
            viewBox="0 0 784.11 815.53"
            aria-hidden
            className={`codexa-star codexa-star-${n}`}
          >
            <path d={STAR_PATH} />
          </svg>
        ))}
      </button>
    );
  },
);
