import { useRef, type ElementType } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

/** A run of characters that shares a colour treatment once it has settled. */
export interface TextSegment {
  text: string;
  /** Applied to a wrapper around this run — e.g. a `bg-clip-text` gradient. */
  className?: string;
}

interface TextMatrixRainProps {
  /** The full string. Used verbatim for assistive tech and when no segments are given. */
  children: string;
  className?: string;
  duration?: number;
  repeat?: boolean;
  /**
   * The colour of the *effect* only — the churning glyphs and the flare as each
   * character lands. Settled text is never given a colour, so it inherits
   * whatever the page already styles it with.
   */
  accentColor?: string;
  /** Optional per-run styling. Their text must concatenate to `children`. */
  segments?: TextSegment[];
  /** The element to render. Defaults to a div; pass `h1`/`h2` to keep a heading a heading. */
  as?: ElementType;
}

const GLYPHS =
  'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789';

const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;

/** How often a churning character swaps, in milliseconds of real time. */
const SWAP_MS = 42;
/** The fraction of a character's life spent converging on its real value. */
const CONVERGE_WINDOW = 0.14;

interface Char {
  span: HTMLSpanElement;
  final: string;
  /** Progress along the tween, 0–1, at which this character stops churning. */
  lockAt: number;
  lastSwap: number;
  locked: boolean;
}

/**
 * Scramble-in text, matrix style.
 *
 * Each character churns through katakana and settles into place on a wave that
 * sweeps the string, flaring once as it lands.
 *
 * Departures from the supplied component, all forced by where it runs:
 *
 *   1. **The real text is exposed to assistive tech, the scramble is not.**
 *      The animation replaces the element's contents with per-character spans
 *      of random Japanese glyphs, which a screen reader would happily read out.
 *      The animated layer is `aria-hidden` and the true string sits beside it,
 *      visually hidden.
 *
 *   2. **`as` and `segments`.** The original always renders a `div` of one
 *      colour. Here it replaces headings, and a heading may style parts of
 *      itself differently — so it can render any tag, and a run of characters
 *      can carry its own class.
 *
 *   3. **One rAF-driven tween instead of a `setInterval` per character.** See
 *      the note on smoothness below.
 *
 *   4. **It starts when the text is on screen**, not on mount.
 *
 *   5. **Reduced motion is honoured** — the text simply appears.
 *
 *   6. **`ReturnType<typeof setInterval>` instead of `NodeJS.Timeout`**, which
 *      is not in scope for a browser build.
 *
 *   7. **No `"use client"`** — a Next.js App Router marker, meaningless in Vite.
 *
 * ─── What makes it smooth ─────────────────────────────────────────────────────
 *
 * The original gives every character its own 50ms `setInterval` and its own
 * `delayedCall`. Dozens of independent timers drift against each other and
 * against the frame clock, so glyphs change between paints and the whole字
 * field stutters. Here a single tween drives everything from GSAP's ticker, so
 * every swap lands on a frame boundary.
 *
 * Three further things do the actual smoothing:
 *
 *   - the stagger is **eased**, not linear, so the wave accelerates in and
 *     decelerates out rather than marching at a constant rate;
 *   - each character **converges** before it locks: in its last moments it
 *     begins showing its real value at rising probability, so it resolves
 *     rather than snapping;
 *   - the landing flare fades over 0.45s on `power3.out`, and is a `text-shadow`
 *     rather than a transform or an opacity — both of which would break the
 *     `bg-clip-text` gradient a heading may be painted with.
 */
export default function TextMatrixRain({
  children,
  className = '',
  duration = 2.2,
  repeat = false,
  accentColor = '#ff3ea5',
  segments,
  as: Tag = 'div',
}: TextMatrixRainProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  // A fresh array literal each render would restart the animation every render.
  const segmentKey = JSON.stringify(segments ?? null);

  useGSAP(
    () => {
      const el = textRef.current;
      const container = containerRef.current;
      if (!el || !container) return;

      // A stream of high-contrast glyphs changing every frame is precisely the
      // motion this query exists to suppress.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.textContent = children;
        return;
      }

      const runs: TextSegment[] = segments?.length ? segments : [{ text: children }];
      const total = runs.reduce((n, run) => n + run.text.length, 0);

      const build = (): Char[] => {
        el.innerHTML = '';
        const chars: Char[] = [];
        let index = 0;

        for (const run of runs) {
          const host = document.createElement('span');
          if (run.className) host.className = run.className;
          el.appendChild(host);

          /**
           * Characters are grouped into words, and only the gaps between words
           * are ordinary spaces.
           *
           * Each character must be `inline-block` to be animated on its own,
           * and a run of inline-blocks offers the browser a break opportunity
           * between every one — so a heading wraps as "Code together, a /
           * ctually together." A `nowrap` wrapper per word restores the normal
           * atom of line breaking, and the real space between words is then the
           * only place a line may break.
           */
          let word: HTMLSpanElement | null = null;

          for (const char of run.text) {
            if (char === ' ') {
              const gap = document.createElement('span');
              gap.textContent = ' ';
              host.appendChild(gap);
              word = null;
              index += 1;
              continue;
            }

            if (!word) {
              word = document.createElement('span');
              word.style.display = 'inline-block';
              word.style.whiteSpace = 'nowrap';
              host.appendChild(word);
            }

            const span = document.createElement('span');
            span.style.display = 'inline-block';
            span.style.color = accentColor;
            span.style.textShadow = `0 0 10px ${accentColor}`;
            span.textContent = randomGlyph();
            word.appendChild(span);

            // Eased so the wave eases in and out instead of marching. The
            // jitter keeps neighbours from locking in lockstep.
            const position = total > 1 ? index / (total - 1) : 0;
            const eased = gsap.parseEase('power2.inOut')(position);
            chars.push({
              span,
              final: char,
              lockAt: Math.min(0.98, eased * 0.82 + Math.random() * 0.14),
              lastSwap: 0,
              locked: false,
            });
            index += 1;
          }
        }

        return chars;
      };

      const lock = (char: Char) => {
        char.locked = true;
        char.span.textContent = char.final;
        // Clearing the inline colour is what hands the character back to the
        // page's own styling — plain ink, or a gradient on an ancestor.
        char.span.style.color = '';
        gsap.fromTo(
          char.span,
          { textShadow: `0 0 18px ${accentColor}, 0 0 36px ${accentColor}` },
          { duration: 0.45, textShadow: '0 0 0px transparent', ease: 'power3.out' },
        );
      };

      let tween: gsap.core.Tween | undefined;

      const runAnimation = () => {
        const chars = build();
        const state = { progress: 0 };

        tween = gsap.to(state, {
          progress: 1,
          duration,
          ease: 'none',
          onUpdate: () => {
            const nowMs = (tween?.time() ?? 0) * 1000;

            for (const char of chars) {
              if (char.locked) continue;

              if (state.progress >= char.lockAt) {
                lock(char);
                continue;
              }
              if (nowMs - char.lastSwap < SWAP_MS) continue;
              char.lastSwap = nowMs;

              // Near the end, start showing the truth more and more often, so
              // the character resolves instead of snapping.
              const toGo = char.lockAt - state.progress;
              const settling = 1 - Math.min(1, toGo / CONVERGE_WINDOW);
              char.span.textContent = Math.random() < settling * 0.6 ? char.final : randomGlyph();
            }
          },
          onComplete: () => {
            for (const char of chars) if (!char.locked) lock(char);
          },
        });
      };

      let repeatInterval: ReturnType<typeof setInterval> | undefined;

      const start = () => {
        runAnimation();
        if (!repeat) return;
        repeatInterval = setInterval(() => runAnimation(), (duration + 1) * 1000);
      };

      /**
       * Start when the text is actually on screen.
       *
       * A run-once animation that fires on mount is over long before a reader
       * scrolls to a heading near the foot of the page — they arrive to static
       * text and never learn there was an effect. Costs nothing at the top of
       * the page, where the element is already visible.
       */
      let observer: IntersectionObserver | undefined;
      if (typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer?.disconnect();
            start();
          },
          { threshold: 0.35 },
        );
        observer.observe(container);
      } else {
        start();
      }

      return () => {
        observer?.disconnect();
        if (repeatInterval) clearInterval(repeatInterval);
        tween?.kill();
      };
    },
    { scope: containerRef, dependencies: [children, duration, repeat, accentColor, segmentKey] },
  );

  return (
    <Tag ref={containerRef} className={className}>
      {/* The animated layer: glyph churn until each character settles. */}
      <span ref={textRef} aria-hidden>
        {children}
      </span>
      {/* What the page actually says, for anything that is not looking. */}
      <span className="sr-only">{children}</span>
    </Tag>
  );
}
