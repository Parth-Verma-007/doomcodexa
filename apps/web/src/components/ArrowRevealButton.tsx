import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';
import { cn } from '../lib/utils.js';

/**
 * `Link` driven by framer-motion — built from `m`, not `motion`, so it uses the
 * feature set `LazyMotion` loads rather than pulling the whole library in.
 *
 * Driven by motion so that `whileHover` and `whileFocus` fire on the
 * anchor itself. Wrapping a motion `div` in a plain `Link` would leave keyboard
 * users with no animation at all: focus lands on the anchor, and focus events
 * do not reach a child.
 */
const MotionLink = m.create(Link);

/** Distance the pill sits to the left of the label, in px. Matches `-left-12`. */
const PILL_OFFSET = 48;
/** Breathing room past the end of the label when the pill is expanded. */
const PILL_TAIL = 20;

interface ArrowRevealButtonProps {
  to: string;
  children: string;
  className?: string;
}

/**
 * A pill that expands out from behind the label, sweeping it from ink to white.
 *
 * Adapted from the supplied component. What changed, and why:
 *
 *   1. **It is a link.** The original is a `div` with a cursor style — no
 *      keyboard access, nothing announced, no destination. This renders a
 *      router `Link`, so it is tabbable, announced as a link, and opens in a
 *      new tab on middle-click like any other.
 *
 *   2. **The expanded width is measured, not hard-coded.** `width: 175` was
 *      tuned for the five letters of "WATCH MORE". This label is "Go to your
 *      projects", and a fixed number would either clip it or overshoot. A
 *      `ResizeObserver` on the label keeps the target correct through font
 *      loading, theme changes and any future wording.
 *
 *   3. **Colour comes from tokens.** The original hard-codes `#0073FF` and a
 *      black label. Black is invisible on this app's dark theme, so the label
 *      is `--color-ink` and the pill is the accent gradient — both of which
 *      follow the theme switch.
 *
 *   4. **Reduced motion collapses it to a plain filled button**, since the
 *      whole effect is a 135px-wide sweep.
 */
export function ArrowRevealButton({ to, children, className }: ArrowRevealButtonProps) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [expandedWidth, setExpandedWidth] = useState(PILL_OFFSET + PILL_TAIL);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const label = labelRef.current;
    if (!label) return;

    const measure = () => setExpandedWidth(label.offsetWidth + PILL_OFFSET + PILL_TAIL);
    measure();

    // Fires on font swap and on any re-layout, which is when a fixed width
    // would have quietly gone wrong.
    const observer = new ResizeObserver(measure);
    observer.observe(label);
    return () => observer.disconnect();
  }, [children]);

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionLink
        to={to}
        initial="rest"
        animate="rest"
        whileHover="hover"
        whileFocus="hover"
        transition={
          reduceMotion
            ? { duration: 0 }
            : // Heavy mass with high stiffness: the pill arrives with weight
              // rather than snapping, which is what sells it as a physical slug.
              { type: 'spring', stiffness: 1000, damping: 20, mass: 10 }
        }
        className={cn(
          'relative ml-12 inline-flex cursor-pointer items-center gap-2 rounded-full',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2',
          'focus-visible:ring-offset-surface-0',
          className,
        )}
      >
        <m.span
          aria-hidden
          variants={{ rest: { width: 40 }, hover: { width: expandedWidth } }}
          className="absolute -left-12 flex h-10 origin-left items-center justify-start rounded-full"
          style={{
            background:
              'linear-gradient(180deg, var(--color-accent) 0%, var(--color-accent-hover) 100%)',
            // The original's glow, retinted from its fixed blue to the theme's
            // accent so it still reads as light coming off the pill.
            boxShadow:
              '0 42px 107px color-mix(in oklab, var(--color-accent) 34%, transparent),' +
              '0 24.7px 32.3px color-mix(in oklab, var(--color-accent) 19%, transparent),' +
              '0 10.3px 13.4px color-mix(in oklab, var(--color-accent) 22%, transparent),' +
              '0 3.7px 4.8px color-mix(in oklab, var(--color-accent) 15%, transparent),' +
              'inset 0 1px 18px 2px color-mix(in oklab, white 55%, transparent),' +
              'inset 0 1px 4px 2px color-mix(in oklab, white 55%, transparent)',
          }}
        >
          <m.svg
            variants={{ rest: { x: 0, scale: 1 }, hover: { x: 10, scale: 1.05 } }}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="ml-1.5 text-white"
          >
            {/* The shaft only appears once the pill has room for it. */}
            <m.path
              transition={{ duration: 0.15, delay: 0.05 }}
              variants={{ rest: { opacity: 0 }, hover: { opacity: 1 } }}
              d="M5 12h14"
            />
            <path d="m12 5 7 7-7 7" />
          </m.svg>
        </m.span>

        <m.span
          ref={labelRef}
          transition={{ delay: 0.1, duration: 0.4 }}
          variants={{
            rest: { color: 'var(--color-ink)' },
            hover: { color: '#ffffff' },
          }}
          className="z-20 whitespace-nowrap text-sm font-medium"
        >
          {children}
        </m.span>
      </MotionLink>
    </LazyMotion>
  );
}

export default ArrowRevealButton;
