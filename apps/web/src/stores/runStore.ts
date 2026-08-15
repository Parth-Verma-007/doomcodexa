import { create } from 'zustand';
import type { RunStatus, UserDto } from '@codexa/shared';

/**
 * Live run state, driven entirely by socket events.
 *
 * The terminal's text buffer is NOT here — it lives inside the xterm instance,
 * which is imperative and owns its own scrollback. Putting a megabyte of
 * program output into React state would re-render the tree on every chunk.
 */

export interface LiveRun {
  runId: string;
  by: UserDto | null;
  entrypoint: string;
  status: RunStatus | 'starting';
  phase: 'queued' | 'compiling' | 'running' | 'finished';
  queuePosition: number | null;
  exitCode: number | null;
  compileMs: number | null;
  runMs: number | null;
  reason: string | null;
  truncated: boolean;
  /** True when this client started it — only the owner can send stdin. */
  mine: boolean;
  startedAt: number;
}

interface RunState {
  current: LiveRun | null;
  /** Set while waiting for the server to acknowledge a start request. */
  starting: boolean;

  begin: (run: LiveRun) => void;
  setStarting: (starting: boolean) => void;
  setQueued: (runId: string, position: number) => void;
  setPhase: (runId: string, phase: 'compiling' | 'running') => void;
  markTruncated: (runId: string) => void;
  finish: (
    runId: string,
    result: {
      status: RunStatus;
      exitCode: number | null;
      compileMs: number | null;
      runMs: number | null;
      reason?: string;
    },
  ) => void;
  clear: () => void;
}

export const useRunStore = create<RunState>((set, get) => ({
  current: null,
  starting: false,

  begin: (run) => set({ current: run, starting: false }),
  setStarting: (starting) => set({ starting }),

  // Every mutation checks the runId. Two people can press Run at once, and a
  // late event from a superseded run must not overwrite the current one.
  setQueued: (runId, position) => {
    const current = get().current;
    if (current?.runId !== runId) return;
    set({ current: { ...current, phase: 'queued', queuePosition: position } });
  },

  setPhase: (runId, phase) => {
    const current = get().current;
    if (current?.runId !== runId) return;
    set({ current: { ...current, phase, queuePosition: null, status: phase } });
  },

  markTruncated: (runId) => {
    const current = get().current;
    if (current?.runId !== runId) return;
    set({ current: { ...current, truncated: true } });
  },

  finish: (runId, result) => {
    const current = get().current;
    if (current?.runId !== runId) return;
    set({
      current: {
        ...current,
        phase: 'finished',
        status: result.status,
        exitCode: result.exitCode,
        compileMs: result.compileMs,
        runMs: result.runMs,
        reason: result.reason ?? null,
        queuePosition: null,
      },
    });
  },

  clear: () => set({ current: null, starting: false }),
}));

export function isRunActive(run: LiveRun | null): boolean {
  return run !== null && run.phase !== 'finished';
}

export const STATUS_LABEL: Record<RunStatus | 'starting', string> = {
  starting: 'Starting',
  queued: 'Queued',
  compiling: 'Compiling',
  running: 'Running',
  success: 'Finished',
  error: 'Error',
  timeout: 'Timed out',
  killed: 'Stopped',
  oom: 'Out of memory',
  failed: 'Failed',
};
