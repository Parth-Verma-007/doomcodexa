import { useEffect, useRef, useState } from 'react';
import type { LanguageId } from '@codexa/shared';

/**
 * The four languages on the faces of a rotating prism.
 *
 * Adapted from the supplied cube carousel. What changed:
 *
 *   1. **The faces are code, not photographs.** The original pulls random
 *      images from picsum. This panel exists to show what the IDE looks like,
 *      so each face is a small editor rendered in the app's own tokens — sharp
 *      at any density, correct in both themes, and impossible to leave stale.
 *
 *   2. **Four slides on four faces.** With `SLIDES.length === 4` the original's
 *      modular face-reassignment reduces to identity, so it is gone. Nothing is
 *      swapped mid-turn and nothing can flash.
 *
 *   3. **It sizes itself.** The original hard-codes a 440×300 face inside an
 *      `80vh` scene, which overflows a phone and leaves a crater on a desktop.
 *      The face is measured from the container and clamped.
 *
 *   4. **Reduced motion stops the rotation.** A prism turning on a timer is
 *      unsolicited movement; with the preference set it holds still and the
 *      arrows still work.
 *
 *   5. **Keyboard and labels.** The original is drag-only and silent. This is a
 *      labelled group with arrow-key support and a live region naming the
 *      visible language.
 */

interface Slide {
  id: LanguageId;
  label: string;
  filename: string;
  /** Pre-tokenised so there is no highlighter on the landing page's payload. */
  lines: Token[][];
  /** What running it prints — the same program in four languages, same answer. */
  ran: string;
}

type Token = { t: string; c?: 'kw' | 'str' | 'type' | 'fn' | 'num' | 'com' };

/**
 * Driven by variables rather than fixed hex, because a palette tuned for a
 * near-black editor turns pale and unreadable on white. The values live in
 * index.css beside the rest of the theme and are the same ones lib/monaco.ts
 * gives the real editor, so this panel and the product agree.
 */
const TOKEN_CLASS: Record<NonNullable<Token['c']>, string> = {
  kw: 'text-[var(--syntax-kw)]',
  str: 'text-[var(--syntax-str)]',
  type: 'text-[var(--syntax-type)]',
  fn: 'text-[var(--syntax-fn)]',
  num: 'text-[var(--syntax-num)]',
  com: 'text-[var(--syntax-com)] italic',
};

const SLIDES: Slide[] = [
  {
    id: 'c',
    ran: 'Sum = 15',
    label: 'C',
    filename: 'main.c',
    lines: [
      [{ t: '#include', c: 'kw' }, { t: ' ' }, { t: '<stdio.h>', c: 'str' }],
      [],
      [{ t: 'int', c: 'type' }, { t: ' ' }, { t: 'main', c: 'fn' }, { t: '(void) {' }],
      [{ t: '    ' }, { t: 'int', c: 'type' }, { t: ' a, b;' }],
      [
        { t: '    ' },
        { t: 'scanf', c: 'fn' },
        { t: '(' },
        { t: '"%d %d"', c: 'str' },
        { t: ', &a, &b);' },
      ],
      [
        { t: '    ' },
        { t: 'printf', c: 'fn' },
        { t: '(' },
        { t: '"Sum = %d\\n"', c: 'str' },
        { t: ', a + b);' },
      ],
      [{ t: '}' }],
    ],
  },
  {
    id: 'cpp',
    ran: 'Sum = 15',
    label: 'C++',
    filename: 'main.cpp',
    lines: [
      [{ t: '#include', c: 'kw' }, { t: ' ' }, { t: '<iostream>', c: 'str' }],
      [],
      [{ t: 'int', c: 'type' }, { t: ' ' }, { t: 'main', c: 'fn' }, { t: '() {' }],
      [{ t: '    ' }, { t: 'int', c: 'type' }, { t: ' a, b;' }],
      [{ t: '    std::cin >> a >> b;' }],
      [{ t: '    std::cout << ' }, { t: '"Sum = "', c: 'str' }, { t: ' << a + b;' }],
      [{ t: '}' }],
    ],
  },
  {
    id: 'java',
    ran: 'Sum = 15',
    label: 'Java',
    filename: 'Main.java',
    lines: [
      [{ t: 'import', c: 'kw' }, { t: ' java.util.Scanner;' }],
      [],
      [{ t: 'public class', c: 'kw' }, { t: ' ' }, { t: 'Main', c: 'type' }, { t: ' {' }],
      [
        { t: '  ' },
        { t: 'public static void', c: 'kw' },
        { t: ' ' },
        { t: 'main', c: 'fn' },
        { t: '(String[] a) {' },
      ],
      [
        { t: '    ' },
        { t: 'Scanner', c: 'type' },
        { t: ' s = ' },
        { t: 'new', c: 'kw' },
        { t: ' ' },
        { t: 'Scanner', c: 'type' },
        { t: '(System.in);' },
      ],
      [{ t: '    System.out.println(s.nextInt() + s.nextInt());' }],
      [{ t: '  }' }],
      [{ t: '}' }],
    ],
  },
  {
    id: 'python',
    ran: 'Sum = 15',
    label: 'Python',
    filename: 'main.py',
    lines: [
      [{ t: '# reads two numbers and adds them', c: 'com' }],
      [],
      [
        { t: 'def', c: 'kw' },
        { t: ' ' },
        { t: 'main', c: 'fn' },
        { t: '() -> ' },
        { t: 'None', c: 'type' },
        { t: ':' },
      ],
      [
        { t: '    a, b = ' },
        { t: 'map', c: 'fn' },
        { t: '(' },
        { t: 'int', c: 'type' },
        { t: ', ' },
        { t: 'input', c: 'fn' },
        { t: '().split())' },
      ],
      [
        { t: '    ' },
        { t: 'print', c: 'fn' },
        { t: '(' },
        { t: 'f"Sum = {a + b}"', c: 'str' },
        { t: ')' },
      ],
      [],
      [{ t: 'main', c: 'fn' }, { t: '()' }],
    ],
  },
];

const FACES = SLIDES.length; // a four-sided prism, one language per face
const QUARTER = 360 / FACES;
/** Frames of stillness before it advances on its own — roughly four seconds. */
const IDLE_FRAMES = 230;
/** How hard the prism shrinks mid-turn, so it appears to need room to swing. */
const DIP = 0.28;

export function LanguageCarousel() {
  const sceneRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const prismRef = useRef<HTMLDivElement>(null);

  const rotation = useRef(0);
  const target = useRef(0);
  /**
   * Frames since the last interaction. A ref rather than a closure variable so
   * the dot handlers can reset it: otherwise the auto-advance keeps counting
   * through a click and fires a moment later, carrying the prism one face past
   * whatever the user just asked for.
   */
  const idle = useRef(0);
  const [face, setFace] = useState(0);
  const [size, setSize] = useState({ w: 520, h: 320 });

  // ─── Responsive face ────────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const measure = () => {
      // Room for the prism to swing without clipping its corners: at 45° a face
      // reaches out by half its own depth, so leave a comfortable margin.
      const w = Math.max(260, Math.min(560, scene.clientWidth - 96));
      setSize({ w, h: Math.round(w * 0.62) });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scene);
    return () => observer.disconnect();
  }, []);

  // ─── Rotation ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let dragging = false;
    let lastX = 0;
    let raf = 0;
    let onScreen = true;

    const tick = () => {
      raf = requestAnimationFrame(tick);

      // Nothing to do while it is scrolled away. `requestAnimationFrame` pauses
      // in a background *tab*, but not for a section the reader has simply
      // scrolled past — and this page keeps three blurred blooms and several
      // backdrop-filtered panels busy already.
      if (!onScreen) return;

      if (!still && !dragging && ++idle.current > IDLE_FRAMES) {
        target.current = (Math.round(target.current / QUARTER) + 1) * QUARTER;
        idle.current = 0;
      }

      // Ease toward the target rather than jumping, so a drag release settles.
      rotation.current += (target.current - rotation.current) * 0.085;

      const prism = prismRef.current;
      const scaler = scaleRef.current;
      if (prism && scaler) {
        prism.style.transform = `translateZ(${-size.w / 2}px) rotateY(${-rotation.current}deg)`;
        const frac = Math.abs(rotation.current / QUARTER - Math.round(rotation.current / QUARTER));
        scaler.style.transform = `scale(${1 - Math.min(0.5, frac) * DIP})`;
      }

      const settled = Math.round(rotation.current / QUARTER);
      setFace((current) => (current === settled ? current : settled));
    };
    tick();

    const onDown = (event: PointerEvent) => {
      dragging = true;
      lastX = event.clientX;
      (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!dragging) return;
      target.current -= (event.clientX - lastX) * 0.28;
      lastX = event.clientX;
      idle.current = 0;
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      target.current = Math.round(target.current / QUARTER) * QUARTER;
      idle.current = 0;
    };

    scene.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    const visibility = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        // Come back to a fresh timer rather than an auto-advance that fires the
        // instant the section scrolls into view.
        if (onScreen) idle.current = 0;
      },
      { threshold: 0.1 },
    );
    visibility.observe(scene);

    return () => {
      cancelAnimationFrame(raf);
      visibility.disconnect();
      scene.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [size.w]);

  /** Step relative to wherever the prism is heading. */
  const turn = (by: number) => {
    target.current = (Math.round(target.current / QUARTER) + by) * QUARTER;
    idle.current = 0;
  };

  /**
   * Go to a specific face, computed from the live rotation target rather than
   * from React state.
   *
   * `turn(index - visible)` looks equivalent and is not: `visible` is state, so
   * it lags the target by however long a render takes, and the auto-advance
   * moves the target on its own between renders. Clicking a dot could then land
   * one face off. Deriving the delta from `target.current` has no such window.
   */
  const goTo = (index: number) => {
    const step = Math.round(target.current / QUARTER);
    const currentFace = ((step % FACES) + FACES) % FACES;

    let delta = index - currentFace;
    // Take the short way round rather than unwinding three faces.
    if (delta > FACES / 2) delta -= FACES;
    if (delta < -FACES / 2) delta += FACES;

    target.current = (step + delta) * QUARTER;
    idle.current = 0;
  };

  const visible = ((face % FACES) + FACES) % FACES;

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label="The same editor in each supported language"
      className="relative"
    >
      <div
        ref={sceneRef}
        className="flex cursor-grab select-none items-center justify-center overflow-hidden active:cursor-grabbing"
        style={{ perspective: '1600px', height: size.h + 96 }}
      >
        <div ref={scaleRef} style={{ willChange: 'transform' }}>
          <div
            ref={prismRef}
            className="relative"
            style={{
              width: size.w,
              height: size.h,
              transformStyle: 'preserve-3d',
              willChange: 'transform',
            }}
          >
            {SLIDES.map((slide, index) => (
              <div
                key={slide.id}
                // Only the face in front is offered to assistive tech; the other
                // three are turned away and would just be noise.
                aria-hidden={index !== visible}
                className="codexa-glass absolute inset-0 overflow-hidden rounded-xl"
                style={{
                  transform: `rotateY(${index * QUARTER}deg) translateZ(${size.w / 2}px)`,
                  backfaceVisibility: 'hidden',
                }}
              >
                <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
                  <span className="flex gap-1.5" aria-hidden>
                    <span className="size-2 rounded-full bg-danger/70" />
                    <span className="size-2 rounded-full bg-warning/70" />
                    <span className="size-2 rounded-full bg-success/70" />
                  </span>
                  <span className="ml-1 font-mono text-[11px] text-ink-faint">
                    {slide.filename}
                  </span>
                  <span className="ml-auto rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-ink-muted">
                    {slide.label}
                  </span>
                </div>

                <pre className="overflow-hidden px-3 pt-3 font-mono text-[12px] leading-[1.55]">
                  <code>
                    {slide.lines.map((line, n) => (
                      <span key={n} className="block whitespace-pre">
                        <span className="mr-3 inline-block w-3 select-none text-right text-ink-faint/60">
                          {n + 1}
                        </span>
                        {line.map((token, i) => (
                          <span key={i} className={token.c ? TOKEN_CLASS[token.c] : undefined}>
                            {token.t}
                          </span>
                        ))}
                      </span>
                    ))}
                  </code>
                </pre>

                {/* Pinned to the foot of the face: four languages, four
                    programs, one answer — which is the point of the panel, and
                    it fills space the code alone leaves empty. */}
                <div className="absolute inset-x-0 bottom-0 border-t border-border/70 bg-surface-0/60 px-3 py-2.5 font-mono text-[11px] leading-[1.6]">
                  <p className="text-ink-muted">$ run {slide.filename}</p>
                  <p className="text-ink">
                    Enter two numbers: <span className="text-accent">7 8</span>
                  </p>
                  <p className="text-ink">{slide.ran}</p>
                  <p className="text-success">[success · exit 0]</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Controls ─────────────────────────────────────────────────────── */}
      <div className="mt-1 flex items-center justify-center gap-2">
        {SLIDES.map((slide, index) => (
          <button
            key={slide.id}
            type="button"
            onClick={() => goTo(index)}
            // Arrow keys belong on the dots rather than the group: a `group` is
            // not focusable, so a handler there would never fire for a keyboard
            // user — and a real button is where they already are.
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') turn(-1);
              if (event.key === 'ArrowRight') turn(1);
            }}
            aria-label={`Show ${slide.label}`}
            aria-current={index === visible}
            className={
              index === visible
                ? 'h-1.5 w-6 rounded-full bg-accent transition-all'
                : 'h-1.5 w-1.5 rounded-full bg-border-strong transition-all hover:bg-ink-faint'
            }
          />
        ))}
      </div>

      <p aria-live="polite" className="sr-only">
        {SLIDES[visible]!.label}
      </p>
    </div>
  );
}

export default LanguageCarousel;
