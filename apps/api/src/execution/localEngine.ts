import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import PQueue from 'p-queue';
import { LANGUAGES, type LanguageId, type RunSpec, type RunStatus } from '@codexa/shared';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';
import {
  activeRuns,
  queueDepth,
  runDuration,
  runQueueWait,
  runsTotal,
} from '../observability/metrics.js';
import { OutputStream } from './outputStream.js';
import { SOURCE_EXTENSIONS, validateJavaEntrypoint } from './languages.js';
import { materialise, type Workspace } from './workspace.js';
import type { EngineStats, ExecutionEngine, RunHandle, RunSink } from './types.js';

/**
 * Execution without Docker: compilers and interpreters are spawned directly on
 * the host.
 *
 * ─── What this buys, and what it costs ────────────────────────────────────────
 *
 * It removes the single hardest dependency in the project. Docker Desktop needs
 * hardware virtualisation enabled in firmware, which is not something you can
 * turn on from a terminal — so on a machine without it, the Run button could
 * never work at all. With this engine you install a compiler and it runs.
 *
 * The cost is the sandbox. A container gave us `NetworkMode: none`, a hard
 * memory ceiling, a pid limit, a read-only root and a dropped capability set.
 * A child process gets *none* of that: it runs as the same OS user as the API,
 * with that user's network access, filesystem access and privileges. A program
 * that does `system("rm -rf ~")` will do exactly that.
 *
 * So the honest scope of this engine is: **you, and people you have personally
 * invited, on a machine you control.** That is exactly the collaborative
 * pair-programming case this project is for. It is not safe for arbitrary
 * strangers, and `index.ts` refuses to select it in production unless someone
 * has explicitly acknowledged that.
 *
 * ─── What it still enforces ───────────────────────────────────────────────────
 *
 *   - a wall-clock limit on both compilation and execution, with a killed
 *     process tree (a runaway loop cannot outlive its budget);
 *   - the 1MB output cap and the 30ms batcher, so a tight print loop cannot
 *     take the browser or the server down;
 *   - a per-run scratch directory, removed afterwards, with every path
 *     re-validated by `materialise`;
 *   - a concurrency ceiling shared with the rest of the app.
 *
 * ─── One thing it does better than the container path ─────────────────────────
 *
 * No shell. The Docker engine hands a script to `/bin/sh` and is careful to
 * pass filenames only through environment variables and a manifest, because
 * anything interpolated into that script would be an injection. Here every
 * command is an argv array — `spawn(cmd, [...args])` with no shell — so
 * filenames are passed as opaque arguments and there is no string for a
 * `; rm -rf /` to hide in.
 */

/** A resolved toolchain: how to invoke it, and what to call it in an error. */
interface Tool {
  command: string;
  /** Fixed leading arguments, e.g. `py -3`. */
  prefix: string[];
  version: string;
}

interface Toolchain {
  /** Absent for interpreted languages. */
  compiler?: Tool;
  runtime?: Tool;
}

/**
 * Candidates per language, in preference order. The first that answers a
 * version probe wins, so a machine with clang but no gcc still runs C.
 */
const CANDIDATES: Record<LanguageId, { compilers: string[]; runtimes: string[] }> = {
  c: { compilers: ['gcc', 'clang', 'cc'], runtimes: [] },
  cpp: { compilers: ['g++', 'clang++', 'c++'], runtimes: [] },
  java: { compilers: ['javac'], runtimes: ['java'] },
  python: { compilers: [], runtimes: ['python3', 'python', 'py'] },
};

/** How to tell a user to fix a missing toolchain, per platform. */
const INSTALL_HINT: Record<LanguageId, string> = {
  c: 'Install a C compiler — `winget install BrechtSanders.WinLibs.POSIX.UCRT` on Windows, `apt install build-essential` on Debian/Ubuntu, or Xcode command line tools on macOS.',
  cpp: 'Install a C++ compiler — `winget install BrechtSanders.WinLibs.POSIX.UCRT` on Windows, `apt install build-essential` on Debian/Ubuntu, or Xcode command line tools on macOS.',
  java: 'Install a JDK (which provides both `javac` and `java`) and make sure it is on PATH.',
  python:
    'Install Python 3 from python.org and make sure `python3` or `python` is on PATH. The Microsoft Store stub that ships with Windows does not count.',
};

const EXE = process.platform === 'win32' ? '.exe' : '';

export class LocalExecutionEngine implements ExecutionEngine {
  private readonly queue: PQueue;
  private readonly toolchains = new Map<LanguageId, Toolchain>();
  private readonly active = new Map<string, ActiveRun>();
  private shuttingDown = false;
  private probed = false;

  constructor() {
    this.queue = new PQueue({ concurrency: config.exec.maxConcurrency });
  }

  async initialise(): Promise<void> {
    for (const language of Object.keys(CANDIDATES) as LanguageId[]) {
      const chain = await probeLanguage(language);
      if (chain) this.toolchains.set(language, chain);
    }
    this.probed = true;

    const found = [...this.toolchains.keys()];
    if (found.length === 0) {
      logger.warn('local execution engine: no toolchains found on PATH');
      return;
    }
    logger.info(
      {
        languages: Object.fromEntries(
          [...this.toolchains].map(([id, c]) => [
            id,
            (c.compiler ?? c.runtime)?.version ?? 'unknown',
          ]),
        ),
      },
      'local execution engine ready',
    );
  }

  isAvailable(): boolean {
    return this.toolchains.size > 0;
  }

  unavailableReason(): string | null {
    if (this.toolchains.size > 0) return null;
    if (!this.probed) return 'Execution has not been initialised.';
    return 'No compilers or interpreters were found on this server. Install a JDK, a C/C++ compiler or Python 3 and restart.';
  }

  /** Which languages this host can actually run — used for the error message. */
  supports(language: LanguageId): boolean {
    return this.toolchains.has(language);
  }

  async run(spec: RunSpec, sink: RunSink): Promise<RunHandle> {
    const toolchain = this.toolchains.get(spec.language);
    if (!toolchain) {
      return failFast(
        spec,
        sink,
        `This server cannot run ${LANGUAGES[spec.language].label} — no toolchain was found. ${INSTALL_HINT[spec.language]}`,
      );
    }

    // Java's filename/class rule produces a baffling javac error, so catch it
    // before spending a process on it.
    if (spec.language === 'java') {
      const entry = spec.files.find((f) => f.path === spec.entrypoint);
      if (entry) {
        const check = validateJavaEntrypoint(spec.entrypoint, entry.content);
        if (!check.ok) return failFast(spec, sink, check.message);
      }
    }

    if (this.shuttingDown) {
      return failFast(spec, sink, 'The server is shutting down.');
    }

    if (this.queue.pending >= config.exec.maxConcurrency) {
      sink({ type: 'queued', position: this.queue.size + 1 });
    }

    let settle!: () => void;
    const finished = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const entry: ActiveRun = {
      runId: spec.runId,
      child: null,
      stdinQueue: [],
      killed: false,
      killStatus: null,
      killReason: null,
    };
    this.active.set(spec.runId, entry);

    // Metrics are written here rather than inside the engine internals so that
    // every terminal path — success, compile failure, timeout, kill, or the
    // catch below — is counted exactly once.
    const enqueuedAt = Date.now();
    this.publishQueueGauges();

    void this.queue
      .add(() => this.execute(spec, sink, toolchain, entry, enqueuedAt))
      .catch((err) => {
        logger.error({ err, runId: spec.runId }, 'local run failed');
        runsTotal.inc({ language: spec.language, status: 'failed' });
        sink({
          type: 'exit',
          status: 'failed',
          exitCode: null,
          compileMs: null,
          runMs: null,
          reason: 'The run could not be started.',
        });
      })
      .finally(() => {
        this.active.delete(spec.runId);
        this.publishQueueGauges();
        settle();
      });

    return {
      runId: spec.runId,
      writeStdin: (data) => {
        // Buffer until the program is actually spawned: a user can type into
        // the terminal while the compiler is still running.
        if (entry.child?.stdin?.writable) entry.child.stdin.write(data);
        else entry.stdinQueue.push(data);
      },
      kill: async (reason) => {
        await this.kill(spec.runId, 'killed', reason ?? 'Stopped.');
      },
      finished,
    };
  }

  private async execute(
    spec: RunSpec,
    sink: RunSink,
    toolchain: Toolchain,
    entry: ActiveRun,
    enqueuedAt: number,
  ): Promise<void> {
    // The queue admitted this run, so whatever it waited is now known.
    runQueueWait.observe((Date.now() - enqueuedAt) / 1000);
    const startedAt = Date.now();
    this.publishQueueGauges();
    let workspace: Workspace | null = null;

    /**
     * The single exit point for a run.
     *
     * Every `return` below goes through here, so the terminal status is
     * recorded exactly once no matter which way the run ended — success,
     * compile failure, timeout or kill. Counting at the individual call sites
     * would mean six places to forget.
     */
    const finish = (
      status: RunStatus,
      exitCode: number | null,
      reason?: string,
      runMs: number | null = null,
    ): void => {
      emitExit(sink, stream, status, exitCode, reason, runMs);
      runsTotal.inc({ language: spec.language, status });
      runDuration.observe({ language: spec.language }, (Date.now() - startedAt) / 1000);
    };

    const stream = new OutputStream({
      // No sentinel: compile and run are two processes, so we already know
      // which output is which and drive the transition explicitly.
      sentinel: null,
      maxBytes: config.exec.maxOutputBytes,
      emit: sink,
      onLimitExceeded: () => {
        void this.kill(spec.runId, 'error', 'Produced too much output and was stopped.');
      },
    });

    try {
      workspace = await materialise(spec.runId, spec.language, spec.entrypoint, spec.files);
      const sources = await readManifest(workspace.dir);

      // A compiled language with nothing to compile: the entrypoint is a header,
      // or every source was renamed to an extension this language does not
      // claim. Without this guard the compiler is invoked with no input files
      // and the user gets `gcc: fatal error: no input files`, which says nothing
      // about what they actually did wrong.
      if (toolchain.compiler && sources.length === 0) {
        stream.finish();
        finish(
          'error',
          null,
          `No ${LANGUAGES[spec.language].label} source files to compile. ` +
            `Expected at least one file ending in ${SOURCE_EXTENSIONS[spec.language].join(' or ')}.`,
        );
        return;
      }

      const buildDir = path.join(workspace.dir, '.codexa-build');
      await fs.mkdir(buildDir, { recursive: true });

      sink({ type: 'status', phase: 'compiling', at: Date.now() });

      // ─── Compile ────────────────────────────────────────────────────────────
      if (toolchain.compiler) {
        const argv = compileArgv(spec.language, toolchain.compiler, sources, buildDir);
        const result = await this.runProcess({
          entry,
          command: toolchain.compiler.command,
          args: argv,
          cwd: workspace.dir,
          timeoutMs: config.exec.compileTimeoutMs,
          onOutput: (text) => stream.write(text),
          stdin: null,
        });

        if (result.timedOut) {
          stream.finish();
          finish(
            'timeout',
            null,
            `Compilation took longer than ${config.exec.compileTimeoutMs / 1000}s.`,
          );
          return;
        }
        if (entry.killed) {
          stream.finish();
          finish(entry.killStatus ?? 'killed', null, entry.killReason ?? 'Stopped.');
          return;
        }
        if (result.code !== 0) {
          stream.finish();
          finish('error', result.code, 'Compilation failed.');
          return;
        }
      }

      // ─── Run ────────────────────────────────────────────────────────────────
      stream.beginProgram();
      const runStartedAt = Date.now();

      const { command, args } = programArgv(spec, toolchain, buildDir, workspace.entrypoint);
      const result = await this.runProcess({
        entry,
        command,
        args,
        cwd: workspace.dir,
        timeoutMs: config.exec.runTimeoutMs,
        onOutput: (text) => stream.write(text),
        stdin: spec.interactive ? 'open' : (spec.stdin ?? ''),
      });

      stream.finish();
      const runMs = Date.now() - runStartedAt;

      if (result.timedOut) {
        finish(
          'timeout',
          null,
          `Took longer than ${config.exec.runTimeoutMs / 1000}s and was stopped.`,
          runMs,
        );
        return;
      }
      if (entry.killed) {
        finish(entry.killStatus ?? 'killed', null, entry.killReason ?? 'Stopped.', runMs);
        return;
      }

      const status: RunStatus = result.code === 0 ? 'success' : 'error';
      finish(
        status,
        result.code,
        status === 'success' ? undefined : `Exited with code ${result.code}.`,
        runMs,
      );
    } finally {
      await workspace?.cleanup();
    }
  }

  /** Spawn one process, wire its output, and resolve when it is gone. */
  private runProcess(options: {
    entry: ActiveRun;
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    onOutput: (text: string) => void;
    /** `'open'` keeps stdin open for interactive input; a string is written then closed. */
    stdin: string | 'open' | null;
  }): Promise<{ code: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        // Never a shell. Arguments stay opaque, so a filename cannot become
        // a command no matter what it contains.
        shell: false,
        windowsHide: true,
        // A process group on POSIX, so a compiler that forks children can be
        // killed as a unit rather than leaving orphans behind.
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          // A stable, minimal environment: the program should not inherit the
          // server's secrets (Mongo URI, Clerk keys) just because it is a child.
          HOME: options.cwd,
          USERPROFILE: options.cwd,
          TEMP: options.cwd,
          TMP: options.cwd,
          SYSTEMROOT: process.env.SYSTEMROOT,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
        },
      });

      options.entry.child = child;

      let settled = false;
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        void killTree(child);
      }, options.timeoutMs);
      timer.unref?.();

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', options.onOutput);
      child.stderr.on('data', options.onOutput);

      if (options.stdin === 'open') {
        // Flush anything typed while the compiler was still running.
        for (const pending of options.entry.stdinQueue.splice(0)) child.stdin.write(pending);
      } else if (typeof options.stdin === 'string') {
        if (options.stdin) {
          child.stdin.write(options.stdin.endsWith('\n') ? options.stdin : `${options.stdin}\n`);
        }
        child.stdin.end();
      } else {
        child.stdin.end();
      }

      // A program that exits while we are mid-write makes stdin throw EPIPE.
      // That is normal, not an error worth surfacing.
      child.stdin.on('error', () => {});

      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.entry.child = null;
        resolve({ code, timedOut });
      };

      child.on('error', (err) => {
        options.onOutput(`Could not start ${options.command}: ${err.message}\n`);
        done(null);
      });
      child.on('close', (code) => done(code));
    });
  }

  private async kill(runId: string, status: RunStatus, reason: string): Promise<void> {
    const entry = this.active.get(runId);
    if (!entry || entry.killed) return;
    entry.killed = true;
    entry.killStatus = status;
    entry.killReason = reason;
    if (entry.child) await killTree(entry.child);
  }

  /**
   * Mirror the queue into the Prometheus gauges.
   *
   * Published when a run enters or leaves the queue rather than on a timer, so
   * a scrape landing between two runs still sees the truth. `/metrics` and the
   * runbook both refer to `codexa_queue_depth`; leaving it at zero forever
   * would be worse than not publishing it at all.
   */
  private publishQueueGauges(): void {
    queueDepth.set(this.queue.size);
    activeRuns.set(this.queue.pending);
  }

  stats(): EngineStats {
    return { active: this.queue.pending, queued: this.queue.size };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.queue.clear();
    await Promise.allSettled(
      [...this.active.keys()].map((runId) => this.kill(runId, 'killed', 'Server shutting down.')),
    );
    await this.queue.onIdle().catch(() => undefined);
  }
}

// ─── Command construction ─────────────────────────────────────────────────────

function compileArgv(
  language: LanguageId,
  compiler: Tool,
  sources: string[],
  buildDir: string,
): string[] {
  if (language === 'java') {
    return [...compiler.prefix, '-d', buildDir, ...sources];
  }
  const std = language === 'c' ? '-std=c17' : '-std=c++20';
  // One invocation with every translation unit. The container path compiles
  // each file separately only because it has to keep each filename quoted
  // inside a shell script; with an argv array that problem does not exist.
  return [
    ...compiler.prefix,
    '-O0',
    std,
    '-Wall',
    ...sources,
    '-o',
    path.join(buildDir, `prog${EXE}`),
  ];
}

function programArgv(
  spec: RunSpec,
  toolchain: Toolchain,
  buildDir: string,
  entrypoint: string,
): { command: string; args: string[] } {
  switch (spec.language) {
    case 'java': {
      const runtime = toolchain.runtime!;
      const className = entrypoint
        .split('/')
        .pop()!
        .replace(/\.java$/, '');
      return {
        command: runtime.command,
        args: [
          ...runtime.prefix,
          // Keeps a runaway allocation inside a JVM error the user can read,
          // rather than the OS killing the process with no explanation. It is
          // the only memory ceiling this engine has.
          `-Xmx${Math.floor(config.exec.memoryBytes / 1024 / 1024)}m`,
          '-XX:+UseSerialGC',
          '-XX:TieredStopAtLevel=1',
          '-cp',
          buildDir,
          className,
        ],
      };
    }
    case 'python': {
      const runtime = toolchain.runtime!;
      // -u is what makes `input()` prompts appear before the program blocks.
      return { command: runtime.command, args: [...runtime.prefix, '-u', entrypoint] };
    }
    default:
      return { command: path.join(buildDir, `prog${EXE}`), args: [] };
  }
}

// ─── Toolchain discovery ──────────────────────────────────────────────────────

async function probeLanguage(language: LanguageId): Promise<Toolchain | null> {
  const { compilers, runtimes } = CANDIDATES[language];

  const compiler = await firstWorking(compilers, versionProbe);
  if (compilers.length > 0 && !compiler) return null;

  const runtime = await firstWorking(runtimes, language === 'python' ? pythonProbe : versionProbe);
  if (runtimes.length > 0 && !runtime) return null;

  return { ...(compiler ? { compiler } : {}), ...(runtime ? { runtime } : {}) };
}

async function firstWorking(
  commands: string[],
  probe: (command: string) => Promise<Tool | null>,
): Promise<Tool | null> {
  for (const command of commands) {
    const tool = await probe(command);
    if (tool) return tool;
  }
  return null;
}

async function versionProbe(command: string): Promise<Tool | null> {
  const result = await capture(command, ['--version']);
  if (!result.ok) return null;
  return { command, prefix: [], version: firstLine(result.output) };
}

/**
 * Python needs more than `--version`.
 *
 * Windows ships a stub at `python.exe`/`python3.exe` that is not Python at all
 * — it prints an advert for the Microsoft Store. It answers `--version` with
 * text that looks plausible enough to fool a naive probe, so instead we ask a
 * real interpreter question and require the right answer. `py` also needs an
 * explicit `-3`.
 */
async function pythonProbe(command: string): Promise<Tool | null> {
  const prefix = command === 'py' ? ['-3'] : [];
  const result = await capture(command, [...prefix, '-c', 'import sys;print(sys.version_info[0])']);
  if (!result.ok || result.output.trim() !== '3') return null;

  const version = await capture(command, [...prefix, '--version']);
  return { command, prefix, version: firstLine(version.output) || 'python 3' };
}

function capture(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { shell: false, windowsHide: true });
    } catch {
      resolve({ ok: false, output: '' });
      return;
    }

    let output = '';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output });
    };

    // A probe that hangs must not hold up boot.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, 5_000);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString('utf8')));
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

const firstLine = (text: string): string => text.split(/\r?\n/, 1)[0]?.trim() ?? '';

// ─── Process teardown ─────────────────────────────────────────────────────────

/**
 * Kill a process and everything it spawned.
 *
 * `child.kill()` signals one process. A compiler driver like `gcc` forks `cc1`
 * and `as`, and killing only the driver leaves those running past the timeout
 * — which is exactly the runaway case the timeout exists for. So: `taskkill /T`
 * on Windows, and the negated pid (the process group, hence `detached` at spawn
 * time) elsewhere.
 */
async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // The group is already gone, or was never created — fall back to the pid.
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

interface ActiveRun {
  runId: string;
  child: ChildProcess | null;
  stdinQueue: string[];
  killed: boolean;
  killStatus: RunStatus | null;
  killReason: string | null;
}

/** `materialise` writes the source list; reuse it rather than re-deriving one. */
async function readManifest(dir: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(dir, '.codexa-sources'), 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function emitExit(
  sink: RunSink,
  stream: OutputStream,
  status: RunStatus,
  exitCode: number | null,
  reason?: string,
  runMs: number | null = null,
): void {
  sink({
    type: 'exit',
    status,
    exitCode,
    compileMs: stream.compileMs(),
    runMs,
    ...(reason ? { reason } : {}),
  });
}

/** A run that cannot even start still has to report a terminal state. */
function failFast(spec: RunSpec, sink: RunSink, reason: string): RunHandle {
  sink({
    type: 'exit',
    status: 'failed',
    exitCode: null,
    compileMs: null,
    runMs: null,
    reason,
  });
  return {
    runId: spec.runId,
    writeStdin: () => {},
    kill: async () => {},
    finished: Promise.resolve(),
  };
}
