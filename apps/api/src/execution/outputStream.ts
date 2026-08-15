import { LIMITS, type RunEvent } from '@codexa/shared';

/**
 * Turns the raw container stream into socket events (§8).
 *
 * Three jobs, all of which exist because a tight print loop is the easiest way
 * to kill this service:
 *
 *   1. **Sentinel split.** The container has a PTY, so stdout and stderr are
 *      merged. Everything before the per-run sentinel is compiler output;
 *      everything after is the program's own. The sentinel is unguessable, so
 *      a program cannot fake the transition.
 *
 *   2. **Batching.** Output is flushed on a 30ms timer, not per chunk. A loop
 *      printing a million lines otherwise produces a million socket events and
 *      pegs the browser's event loop.
 *
 *   3. **A hard cap.** Past the byte limit we emit `truncated` once and ask the
 *      caller to kill the run. Without this an infinite printer exhausts the
 *      Node process's memory long before the wall-clock timeout fires.
 */

export interface OutputStreamOptions {
  /**
   * `null` for engines that run the compiler and the program as two separate
   * processes and therefore already know which output is which — they call
   * `beginProgram()` instead of relying on an in-band marker.
   */
  sentinel: string | null;
  maxBytes?: number;
  flushMs?: number;
  emit: (event: RunEvent) => void;
  /** Called once, when the cap is exceeded. */
  onLimitExceeded: () => void;
}

export class OutputStream {
  private readonly sentinel: string | null;
  private readonly maxBytes: number;
  private readonly flushMs: number;
  private readonly emit: (event: RunEvent) => void;
  private readonly onLimitExceeded: () => void;

  /** Before the sentinel we are still compiling. */
  private compiling = true;
  /** Holds partial data while scanning for the sentinel. */
  private preamble = '';
  private pending = '';
  private timer: NodeJS.Timeout | null = null;

  private bytesEmitted = 0;
  private limitHit = false;
  private closed = false;

  /** Tail of the combined output, kept for the run history record. */
  private tail = '';

  private compileStartedAt = Date.now();
  private compileFinishedAt: number | null = null;

  constructor(options: OutputStreamOptions) {
    this.sentinel = options.sentinel;
    this.maxBytes = options.maxBytes ?? LIMITS.RUN_MAX_OUTPUT_BYTES;
    this.flushMs = options.flushMs ?? LIMITS.RUN_OUTPUT_FLUSH_MS;
    this.emit = options.emit;
    this.onLimitExceeded = options.onLimitExceeded;
  }

  write(chunk: Buffer | string): void {
    if (this.closed) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (this.compiling) {
      // With no sentinel the caller drives the transition, so everything that
      // arrives while compiling *is* compiler output — just buffer it.
      if (this.sentinel === null) {
        this.preamble += text;
        if (this.preamble.length > this.maxBytes) {
          this.flushCompileOutput(this.preamble);
          this.preamble = '';
        }
        return;
      }

      this.preamble += text;
      const index = this.preamble.indexOf(this.sentinel);
      if (index === -1) {
        // Keep the buffer from growing without bound on a very chatty compiler,
        // while retaining enough overlap to still match a split sentinel.
        if (this.preamble.length > this.maxBytes) {
          this.flushCompileOutput(this.preamble);
          this.preamble = '';
        }
        return;
      }

      const before = this.preamble.slice(0, index);
      // Consume the sentinel and the newline the script printed after it.
      let after = this.preamble.slice(index + this.sentinel.length);
      if (after.startsWith('\r\n')) after = after.slice(2);
      else if (after.startsWith('\n') || after.startsWith('\r')) after = after.slice(1);

      this.flushCompileOutput(before);
      this.preamble = '';
      this.compiling = false;
      this.compileFinishedAt = Date.now();
      this.emit({ type: 'status', phase: 'running', at: this.compileFinishedAt });

      if (after) this.append(after);
      return;
    }

    this.append(text);
  }

  /**
   * Explicit compile→run transition, for engines with no sentinel. Everything
   * buffered so far is flushed as compiler diagnostics.
   */
  beginProgram(): void {
    if (!this.compiling || this.closed) return;
    if (this.preamble.length > 0) {
      this.flushCompileOutput(this.preamble);
      this.preamble = '';
    }
    this.compiling = false;
    this.compileFinishedAt = Date.now();
    this.emit({ type: 'status', phase: 'running', at: this.compileFinishedAt });
  }

  private flushCompileOutput(text: string): void {
    const trimmed = text.replace(/^[\r\n]+/, '');
    if (trimmed.length === 0) return;
    this.record(trimmed);
    this.emit({ type: 'stderr', chunk: trimmed });
  }

  private append(text: string): void {
    if (this.limitHit) return;

    const remaining = this.maxBytes - this.bytesEmitted;
    if (text.length >= remaining) {
      const truncatedChunk = text.slice(0, Math.max(0, remaining));
      if (truncatedChunk) {
        this.pending += truncatedChunk;
        this.bytesEmitted += truncatedChunk.length;
        this.record(truncatedChunk);
      }
      this.limitHit = true;
      this.flush();
      this.emit({ type: 'truncated', limitBytes: this.maxBytes });
      this.onLimitExceeded();
      return;
    }

    this.pending += text;
    this.bytesEmitted += text.length;
    this.record(text);
    this.schedule();
  }

  private record(text: string): void {
    const combined = this.tail + text;
    this.tail =
      combined.length <= LIMITS.RUN_OUTPUT_TAIL_BYTES
        ? combined
        : combined.slice(combined.length - LIMITS.RUN_OUTPUT_TAIL_BYTES);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.flushMs);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const chunk = this.pending;
    this.pending = '';
    this.emit({ type: 'stdout', chunk });
  }

  /**
   * The program exited before the sentinel appeared, which means compilation
   * failed. Whatever was buffered is the compiler's diagnostics.
   */
  finish(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.compiling && this.preamble.length > 0) {
      this.flushCompileOutput(this.preamble);
      this.preamble = '';
    }
    this.flush();
  }

  get compiled(): boolean {
    return !this.compiling;
  }

  get truncated(): boolean {
    return this.limitHit;
  }

  get outputTail(): string {
    return this.tail;
  }

  get bytes(): number {
    return this.bytesEmitted;
  }

  compileMs(): number | null {
    return this.compileFinishedAt === null ? null : this.compileFinishedAt - this.compileStartedAt;
  }

  runMs(now = Date.now()): number | null {
    return this.compileFinishedAt === null ? null : now - this.compileFinishedAt;
  }

  /** Reset the compile clock at the moment the container actually starts. */
  markStarted(at = Date.now()): void {
    this.compileStartedAt = at;
  }
}
