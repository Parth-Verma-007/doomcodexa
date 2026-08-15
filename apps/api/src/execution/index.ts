import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import { LocalExecutionEngine } from './localEngine.js';
import { ensureWorkspaceRoot, startWorkspaceJanitor } from './workspace.js';
import type { EngineStats, ExecutionEngine, RunHandle, RunSink } from './types.js';
import type { RunSpec } from '@codexa/shared';

/**
 * Execution lifecycle.
 *
 * There is one engine: compilers and interpreters spawned as child processes of
 * the API. Docker is not used and is not an option — the project runs on hosts
 * where a daemon is either unavailable (hardware virtualisation disabled in
 * firmware) or unreachable (a managed container platform will not hand a
 * container the host's docker socket). Carrying a second engine for those hosts
 * meant carrying a second security model, a second set of failure modes and a
 * dependency that was never exercised.
 *
 * What that costs is stated plainly in `localEngine.ts` and repeated in
 * `docs/SECURITY.md`: no network isolation, no memory ceiling. `EXEC_DISABLED=1`
 * turns the Run button off entirely and the rest of the app carries on.
 */

class UnavailableEngine implements ExecutionEngine {
  constructor(private readonly reason: string) {}

  isAvailable(): boolean {
    return false;
  }

  unavailableReason(): string | null {
    return this.reason;
  }

  async run(spec: RunSpec, sink: RunSink): Promise<RunHandle> {
    sink({
      type: 'exit',
      status: 'failed',
      exitCode: null,
      compileMs: null,
      runMs: null,
      reason: this.reason,
    });
    return {
      runId: spec.runId,
      writeStdin: () => {},
      kill: async () => {},
      finished: Promise.resolve(),
    };
  }

  stats(): EngineStats {
    return { active: 0, queued: 0 };
  }

  async shutdown(): Promise<void> {}
}

let engine: ExecutionEngine = new UnavailableEngine('Execution has not been initialised.');
let stopJanitor: (() => void) | null = null;

export async function initialiseExecution(): Promise<ExecutionEngine> {
  if (config.exec.disabled) {
    engine = new UnavailableEngine('Code execution is disabled on this server.');
    return engine;
  }

  const refusal = productionGate();
  if (refusal) {
    logger.warn({ reason: refusal }, 'execution refused');
    engine = new UnavailableEngine(refusal);
    return engine;
  }

  await ensureWorkspaceRoot();

  const local = new LocalExecutionEngine();
  await local.initialise();
  stopJanitor = startWorkspaceJanitor();
  engine = local;

  logger.info({ available: local.isAvailable() }, 'execution engine ready (no container sandbox)');
  return engine;
}

/**
 * Returns a refusal message, or null if execution may run.
 *
 * User code runs as the API's own OS user. On a laptop shared with people you
 * invited that is the point; on a public server it is a remote code execution
 * hole with a Run button attached, so production has to opt in explicitly.
 */
function productionGate(): string | null {
  if (!config.isProduction) return null;
  if (config.exec.allowUnsandboxedLocal) return null;
  return (
    'Execution is off: this server is in production and code runs without a ' +
    'sandbox. Set EXEC_LOCAL_ALLOW_UNSANDBOXED=1 if this host is disposable, ' +
    'or EXEC_DISABLED=1 to hide the Run button entirely.'
  );
}

export function getExecutionEngine(): ExecutionEngine {
  return engine;
}

export async function shutdownExecution(): Promise<void> {
  stopJanitor?.();
  stopJanitor = null;
  await engine.shutdown();
}

export type { ExecutionEngine, RunHandle, RunSink } from './types.js';
