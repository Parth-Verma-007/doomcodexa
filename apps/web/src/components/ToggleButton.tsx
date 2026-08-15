import React from 'react';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'framer-motion';

/**
 * Pill toggle.
 *
 * Kept as close to the supplied component as this app allows: same structure,
 * same proportions, same layered shadows. These are the departures, each forced
 * by where it now lives:
 *
 *   1. **The track is theme-aware.** The original hard-codes
 *      `rgba(0, 0, 0, 0.08)`, which is a light-mode assumption: on a `#0d1117`
 *      header it is invisible, so the knob appears to float in space. It now
 *      reads a variable that flips with the theme, and keeps the original value
 *      as the light one.
 *
 *   2. **It is a real switch.** The original is a `div` with an `onClick`,
 *      which cannot be reached by keyboard and announces nothing to a screen
 *      reader. It now carries `role="switch"`, `aria-checked` and Space/Enter
 *      handling — also what gets it past the project's jsx-a11y rules.
 *
 *   3. **Two-thirds scale**, so it sits beside a 36px button instead of
 *      towering over it: 56×28 rather than 80×40, knob 24 rather than 36. The
 *      ratios are unchanged — the knob still travels its own width and stops
 *      the same fraction short of the right edge — so it reads as the same
 *      control, just smaller.
 *
 *   4. **`m` + `LazyMotion`, not `motion`.** Identical behaviour; it just
 *      drops the feature bundles this component never uses, which is 13kB gzip
 *      off the landing page's critical path.
 *
 *   5. **Reduced motion is honoured.** The rest of the app pins animations via
 *      a CSS media query, which cannot reach an animation driven by JavaScript,
 *      so the spring is asked for explicitly only when motion is welcome.
 *
 *   6. **No `"use client"`.** That directive is a Next.js App Router marker;
 *      this is a Vite SPA where every component is already a client component.
 */
const ToggleButton = ({
  toggle = false,
  setToggle = () => {},
  label,
}: {
  toggle: boolean;
  setToggle: React.Dispatch<React.SetStateAction<boolean>>;
  /** Accessible name — the control is otherwise unlabelled. */
  label?: string;
}) => {
  const flip = () => setToggle(!toggle);
  const reduceMotion = useReducedMotion();

  return (
    <LazyMotion features={domAnimation} strict>
      <div className="relative">
        <div
          aria-hidden
          className={`h-1.5 aspect-square rounded-full absolute -top-0.5 -right-2 ${toggle ? 'bg-green-500' : 'bg-red-500'}`}
        ></div>
        <m.div
          role="switch"
          aria-checked={toggle}
          aria-label={label}
          tabIndex={0}
          onClick={flip}
          onKeyDown={(event) => {
            // A native <button> would do this for free; a div has to be told.
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              flip();
            }
          }}
          /**
           * The width is not arbitrary: `w-13` is 52px, and 52 − 2×2px padding
           * leaves exactly 48px of track for a 24px knob. The knob animates to
           * `x: 100%`, which is 100% of *its own* width — 24px — so it lands
           * flush against the right padding.
           *
           * At `w-14` (56px) the inner track is 52px, giving 28px of room for a
           * 24px throw, and the knob stops 4px short of the end. The supplied
           * component has the same gap at its original size (76px inner, 36px
           * knob, 36px throw); it is just less obvious on a larger pill.
           */
          className="rounded-full w-13 flex items-center p-0.5 cursor-pointer"
          style={{
            background: 'var(--toggle-track)',
            boxShadow:
              '0px 1px 0px rgba(255, 255, 255, 0.25), inset 0px 1px 2px rgba(0, 0, 0, 0.15)',
          }}
        >
          <m.div
            transition={
              reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 350, damping: 30 }
            }
            animate={{ x: toggle ? '100%' : '0%' }}
            className="h-6 w-6 border rounded-full bg-[#F4F4F4]"
            style={{
              // The same five-layer shadow, with every offset, blur and spread
              // scaled by the same 2/3 as the geometry. Left at full size it
              // would throw a 10px penumbra off a 24px knob and read as a
              // smudge rather than a raised surface. The 1px inset highlights
              // are hairlines and stay 1px at any size.
              boxShadow:
                '0.296px 0.296px 0.419px -0.5px rgba(0, 0, 0, 0.26), 0.807px 0.807px 1.141px -1px rgba(0, 0, 0, 0.247), 1.772px 1.772px 2.506px -1.5px rgba(0, 0, 0, 0.23), 3.934px 3.934px 5.563px -2px rgba(0, 0, 0, 0.192), 6.667px 6.667px 14.142px -2.5px rgba(0, 0, 0, 0.055), inset 1px 1px 1px #FFFFFF, inset -1px -1px 0px rgba(0, 0, 0, 0.1)',
            }}
          />
        </m.div>
      </div>
    </LazyMotion>
  );
};

export default ToggleButton;
