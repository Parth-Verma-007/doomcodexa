import { useEffect, useRef } from 'react';
import { useColorMode } from '../../stores/uiStore.js';

/** Tuning, carried over from the supplied effect unchanged. */
const TRAILS = 20;
const NODES_PER_TRAIL = 50;
const FRICTION = 0.5;
const DAMPENING = 0.25;
const TENSION = 0.98;

/** The stroke hue swings through 200°–370°: blue, violet, magenta, back. */
const HUE_CENTRE = 285;
const HUE_SWING = 85;
const HUE_STEP = 0.0015;

/**
 * How long after the last pointer move the loop gives up. Friction halves every
 * node's velocity each frame, so the trails have collapsed onto the cursor long
 * before this — past that the loop is clearing and redrawing nothing.
 */
const IDLE_MS = 2000;

/** Beyond 2× the extra fill costs more than the sharpness is worth. */
const MAX_DPR = 2;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * One ribbon: a chain of nodes, each sprung towards the one ahead of it, the
 * first sprung towards the cursor. The spring weakens along the chain, which is
 * what makes the tail lag and curl rather than following rigidly.
 */
class Trail {
  private readonly spring: number;
  private readonly friction: number;
  private readonly nodes: Node[];

  constructor(spring: number, x: number, y: number) {
    // A little jitter per ribbon, so twenty of them do not move as one.
    this.spring = spring + 0.1 * Math.random() - 0.02;
    this.friction = FRICTION + 0.01 * Math.random() - 0.002;
    this.nodes = Array.from({ length: NODES_PER_TRAIL }, () => ({ x, y, vx: 0, vy: 0 }));
  }

  update(targetX: number, targetY: number) {
    let spring = this.spring;

    const head = this.nodes[0]!;
    head.vx += (targetX - head.x) * spring;
    head.vy += (targetY - head.y) * spring;

    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;

      if (i > 0) {
        const ahead = this.nodes[i - 1]!;
        node.vx += (ahead.x - node.x) * spring;
        node.vy += (ahead.y - node.y) * spring;
        node.vx += ahead.vx * DAMPENING;
        node.vy += ahead.vy * DAMPENING;
      }

      node.vx *= this.friction;
      node.vy *= this.friction;
      node.x += node.vx;
      node.y += node.vy;
      spring *= TENSION;
    }
  }

  /** Quadratic segments through the midpoints, so the chain reads as a curve. */
  draw(ctx: CanvasRenderingContext2D) {
    const head = this.nodes[0]!;
    ctx.beginPath();
    ctx.moveTo(head.x, head.y);

    const last = this.nodes.length - 2;
    let i = 1;
    for (; i < last; i++) {
      const node = this.nodes[i]!;
      const next = this.nodes[i + 1]!;
      ctx.quadraticCurveTo(node.x, node.y, 0.5 * (node.x + next.x), 0.5 * (node.y + next.y));
    }

    const node = this.nodes[i]!;
    const next = this.nodes[i + 1]!;
    ctx.quadraticCurveTo(node.x, node.y, next.x, next.y);
    ctx.stroke();
  }
}

/**
 * Ribbons that chase the cursor, on the landing page only.
 *
 * Adapted from a supplied `useCanvasCursor` hook. The physics and the tuning
 * are its own; what changed is everything around them:
 *
 *   1. **A component with a ref, not a hook hunting `#canvas`.** The hook found
 *      its canvas by document id, so mounting it twice, or before the element
 *      existed, failed silently. Owning the element means it cannot.
 *
 *   2. **It cleans up.** The hook's teardown removed listeners by passing fresh
 *      arrow functions, which match nothing, and never removed the move and
 *      touch handlers at all — they were registered inside the first mousemove.
 *      Leaving the landing page left them running against a dead canvas.
 *
 *   3. **No `preventDefault` on move.** The original called it on every
 *      mousemove *and touchmove*, which on a touch device cancels the scroll —
 *      the landing page could not be scrolled at all.
 *
 *   4. **Fine pointers only, and not under reduced motion.** A cursor effect on
 *      a device with no cursor is trails chasing your finger as you scroll, and
 *      a ribbon following the pointer is precisely the motion that query exists
 *      to suppress.
 *
 *   5. **It reads on both themes.** `lighter` compositing adds to what is
 *      underneath, which is what makes the ribbons glow where they cross — but
 *      on the light theme it runs straight to white and the effect vanishes.
 *      There it paints normally, in a deeper and more opaque ink.
 *
 *   6. **Backing store scaled to the display**, so the 1px strokes are not soft
 *      on a HiDPI screen — and sized from the canvas's own box rather than
 *      `innerWidth - 20`, a guess at the scrollbar.
 *
 *   7. **It stops.** The loop pauses on a hidden tab and gives up two seconds
 *      after the cursor stops, waking on the next move. The original ran
 *      forever, and its `blur` handler set `running = true`, so the pause it
 *      meant to take never happened.
 */
export function CursorRibbon() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mode = useColorMode();
  // Read inside the loop, so switching theme does not tear the canvas down.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !window.matchMedia('(pointer: fine)').matches
    ) {
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let trails: Trail[] = [];
    let frame = 0;
    let phase = Math.random() * 2 * Math.PI;
    let lastMove = 0;
    const pointer = { x: 0, y: 0 };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const box = canvas.getBoundingClientRect();
      width = box.width;
      height = box.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      // Reset rather than multiply — resize fires again on every drag.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const render = () => {
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, width, height);

      if (performance.now() - lastMove > IDLE_MS) {
        frame = 0;
        return;
      }

      phase += HUE_STEP;
      const hue = Math.round(HUE_CENTRE + Math.sin(phase) * HUE_SWING);
      const light = modeRef.current === 'light';

      ctx.globalCompositeOperation = light ? 'source-over' : 'lighter';
      ctx.strokeStyle = light ? `hsla(${hue},65%,45%,0.32)` : `hsla(${hue},50%,50%,0.2)`;
      ctx.lineWidth = 1;

      for (const trail of trails) {
        trail.update(pointer.x, pointer.y);
        trail.draw(ctx);
      }

      frame = requestAnimationFrame(render);
    };

    const onPointerMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      lastMove = performance.now();

      // Built on the first move, not on mount: a ribbon seeded at the origin
      // whips in from the corner the moment the cursor arrives.
      if (trails.length === 0) {
        trails = Array.from(
          { length: TRAILS },
          (_, i) => new Trail(0.4 + (i / TRAILS) * 0.025, pointer.x, pointer.y),
        );
      }

      if (frame === 0) frame = requestAnimationFrame(render);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (trails.length > 0 && frame === 0) {
        lastMove = performance.now();
        frame = requestAnimationFrame(render);
      }
    };

    resize();
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return (
    // `h-full w-full` is not redundant with `inset-0`: a canvas is a replaced
    // element, so with `width: auto` it keeps its intrinsic 300×150 box however
    // its offsets are pinned.
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}
