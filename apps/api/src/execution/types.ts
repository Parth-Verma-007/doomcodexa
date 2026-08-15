import type { RunEvent, RunSpec } from '@codexa/shared';

/**
 * The seam between the API and however code actually gets executed (§3).
 *
 * The API depends on this interface and nothing else, so moving execution to a
 * separate host later means writing one new implementation (an HTTP or queue
 * client) and changing one line of wiring. Building it as a separate service on
 * day one would cost a week of plumbing for the same optionality.
 *
 * Events are delivered to a callback rather than an async iterable. The socket
 * layer is push-based and needs no backpressure protocol — the output cap and
 * the 30ms batcher already bound the flow — and a callback keeps stdin
 * ordering obvious.
 */

export type RunSink = (event: RunEvent) => void;

export interface RunHandle {
  readonly runId: string;
  /** Feed the running program's stdin. No-op once the process has exited. */
  writeStdin(data: string): void;
  /** Terminate early. Safe to call more than once. */
  kill(reason?: string): Promise<void>;
  /** Resolves when the run has reached a terminal state and been cleaned up. */
  readonly finished: Promise<void>;
}

export interface EngineStats {
  active: number;
  queued: number;
}

export interface ExecutionEngine {
  /** False when execution is disabled or no toolchain was found. */
  isAvailable(): boolean;
  /** Human-readable reason when `isAvailable()` is false. */
  unavailableReason(): string | null;
  run(spec: RunSpec, sink: RunSink): Promise<RunHandle>;
  stats(): EngineStats;
  shutdown(): Promise<void>;
}

export class ExecutionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionUnavailableError';
  }
}
