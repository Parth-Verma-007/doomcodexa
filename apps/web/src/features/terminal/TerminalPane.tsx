import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Ban, Eraser, Loader2, Square, Terminal as TerminalIcon } from 'lucide-react';
import { LIMITS } from '@codexa/shared';
import { runSocket } from '../../lib/socket.js';
import { useRunStore, isRunActive, STATUS_LABEL } from '../../stores/runStore.js';
import { useProject } from '../project/ProjectContext.js';
import { formatDuration, cn } from '../../lib/utils.js';
import { useColorMode, useUiStore, type ThemeName } from '../../stores/uiStore.js';

/**
 * The terminal.
 *
 * xterm owns its own buffer — it is an imperative library held in a ref, and
 * its contents never pass through React state (§12). A tight print loop emits
 * hundreds of chunks a second; routing those through `setState` would re-render
 * the tree on every one.
 *
 * Keystrokes go straight to the running container's stdin, which is what makes
 * `scanf`, `Scanner` and `input()` behave the way they do in a real shell.
 */
export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** False until the create-once effect has run, so the first sync is skipped. */
  const appliedOptionsRef = useRef(false);

  const current = useRunStore((s) => s.current);
  const mode = useColorMode();
  const fontSize = useUiStore((s) => s.fontSize);
  const { canEdit } = useProject();

  const [interactive, setInteractive] = useState(true);

  // ─── Create the terminal once ───────────────────────────────────────────────
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        "'JetBrains Mono', 'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize,
      // Bounded so a runaway program cannot grow the DOM without limit.
      scrollback: 5_000,
      theme: TERMINAL_THEMES[mode],
    });

    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    terminalRef.current = terminal;
    fitRef.current = fit;

    /**
     * `open()` creates the render service asynchronously, so measuring straight
     * afterwards reaches into a renderer that does not exist yet — xterm throws
     * `Cannot read properties of undefined (reading 'dimensions')` from its own
     * viewport code. One frame later it is ready. The guard covers the other
     * case too: a pane collapsed to zero height has nothing to measure.
     */
    let frame = requestAnimationFrame(() => {
      frame = 0;
      safeFit(fit);
      // Also deferred: writing pokes the viewport into syncing its scroll area,
      // which reaches for the same not-yet-built render service.
      terminal.writeln('\x1b[2mCodexa terminal — press Run to execute your program.\x1b[0m');
    });

    const observer = new ResizeObserver(() => safeFit(fit));
    observer.observe(element);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    // The constructor already applied both, and re-applying them in the same
    // commit as `open()` makes xterm re-render before it is ready to.
    if (appliedOptionsRef.current) {
      terminal.options.theme = TERMINAL_THEMES[mode];
      terminal.options.fontSize = fontSize;
      if (fitRef.current) safeFit(fitRef.current);
    }
    appliedOptionsRef.current = true;
  }, [mode, fontSize]);

  // ─── Wire run events to the terminal ────────────────────────────────────────
  useEffect(() => {
    const socket = runSocket();
    const store = useRunStore.getState();

    const write = (text: string) => terminalRef.current?.write(text);

    const onStarted = (payload: {
      runId: string;
      by: { id: string; username: string };
      entrypoint: string;
      interactive: boolean;
    }) => {
      terminalRef.current?.clear();
      write(`\x1b[2m$ run ${payload.entrypoint}\x1b[0m\r\n`);
      store.begin({
        runId: payload.runId,
        by: payload.by as never,
        entrypoint: payload.entrypoint,
        status: 'starting',
        phase: 'compiling',
        queuePosition: null,
        exitCode: null,
        compileMs: null,
        runMs: null,
        reason: null,
        truncated: false,
        // Set properly by the ack in `startRun`; this default is corrected there.
        mine: false,
        startedAt: Date.now(),
      });
    };

    const onQueued = ({ runId, position }: { runId: string; position: number }) => {
      useRunStore.getState().setQueued(runId, position);
      write(`\x1b[33mQueued — position ${position}.\x1b[0m\r\n`);
    };

    const onStatus = ({ runId, phase }: { runId: string; phase: 'compiling' | 'running' }) => {
      useRunStore.getState().setPhase(runId, phase);
    };

    const onStdout = ({ chunk }: { chunk: string }) => write(chunk);
    const onStderr = ({ chunk }: { chunk: string }) => write(`\x1b[31m${chunk}\x1b[0m`);

    const onTruncated = ({ runId }: { runId: string }) => {
      useRunStore.getState().markTruncated(runId);
      write(
        `\r\n\x1b[33m── output limit of ${Math.round(LIMITS.RUN_MAX_OUTPUT_BYTES / 1024)} KB reached; the run was stopped ──\x1b[0m\r\n`,
      );
    };

    const onExit = (payload: {
      runId: string;
      status: string;
      exitCode: number | null;
      compileMs: number | null;
      runMs: number | null;
      reason?: string;
    }) => {
      useRunStore.getState().finish(payload.runId, payload as never);
      const ok = payload.status === 'success';
      const colour = ok ? '32' : '31';
      const detail = payload.reason ? ` — ${payload.reason}` : '';
      write(
        `\r\n\x1b[${colour}m[${payload.status}${payload.exitCode === null ? '' : ` · exit ${payload.exitCode}`}${
          payload.runMs === null ? '' : ` · ${formatDuration(payload.runMs)}`
        }]${detail}\x1b[0m\r\n`,
      );
    };

    socket.on('run:started', onStarted);
    socket.on('run:queued', onQueued);
    socket.on('run:status', onStatus);
    socket.on('run:stdout', onStdout);
    socket.on('run:stderr', onStderr);
    socket.on('run:truncated', onTruncated);
    socket.on('run:exit', onExit);

    return () => {
      socket.off('run:started', onStarted);
      socket.off('run:queued', onQueued);
      socket.off('run:status', onStatus);
      socket.off('run:stdout', onStdout);
      socket.off('run:stderr', onStderr);
      socket.off('run:truncated', onTruncated);
      socket.off('run:exit', onExit);
    };
  }, []);

  // ─── Keystrokes → the container's stdin ─────────────────────────────────────
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const disposable = terminal.onData((data) => {
      const run = useRunStore.getState().current;
      // Only the person who started a run may feed it; the server enforces
      // this too, so this is purely to avoid pointless traffic.
      if (!run || !isRunActive(run) || !run.mine) return;

      // Echo locally: the PTY inside the container is not in echo mode for the
      // browser, so without this the user cannot see what they are typing.
      terminal.write(data === '\r' ? '\r\n' : data);
      runSocket().emit('run:stdin', { runId: run.runId, data: data === '\r' ? '\n' : data });
    });

    return () => disposable.dispose();
  }, []);

  const active = isRunActive(current);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-3 py-1.5">
        <TerminalIcon size={13} className="text-ink-muted" />
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Terminal
        </span>

        {current ? (
          <span
            className={cn(
              'ml-2 flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium',
              active ? 'bg-accent/15 text-accent' : statusChipClass(current.status),
            )}
          >
            {active ? <Loader2 size={10} className="animate-spin" /> : null}
            {STATUS_LABEL[current.status] ?? current.status}
            {current.queuePosition !== null ? ` (#${current.queuePosition})` : ''}
          </span>
        ) : null}

        {current?.compileMs !== null && current?.compileMs !== undefined ? (
          <span className="text-[11px] text-ink-faint">
            compiled in {formatDuration(current.compileMs)}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <label className="flex cursor-pointer items-center gap-1.5 pr-2 text-[11px] text-ink-muted">
            <input
              type="checkbox"
              checked={interactive}
              onChange={(event) => setInteractive(event.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            Interactive stdin
          </label>

          {active && current?.mine ? (
            <button
              type="button"
              onClick={() => runSocket().emit('run:kill', { runId: current.runId })}
              title="Stop the run"
              className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-danger hover:bg-danger/10"
            >
              <Square size={11} /> Stop
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => terminalRef.current?.clear()}
            title="Clear the terminal"
            aria-label="Clear the terminal"
            className="rounded p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <Eraser size={13} />
          </button>
        </div>
      </div>

      {!canEdit && !active ? (
        <div className="flex items-center gap-1.5 border-b border-border bg-surface-1 px-3 py-1 text-[11px] text-ink-faint">
          <Ban size={11} />
          You can run this project but not edit it.
        </div>
      ) : null}

      <div ref={containerRef} className="min-h-0 flex-1" />
      <span className="sr-only" aria-live="polite">
        {current ? `Run ${STATUS_LABEL[current.status]}` : 'No run in progress'}
      </span>
    </div>
  );
}

export function useInteractiveStdinPreference(): boolean {
  return true;
}

/**
 * `fit()` measures the DOM, and every way that measurement can be unavailable
 * — renderer not yet constructed, pane collapsed to zero height, terminal
 * already disposed — surfaces as a throw from inside xterm. None of them are
 * actionable, and all of them resolve on the next resize.
 */
function safeFit(fit: FitAddon): void {
  try {
    fit.fit();
  } catch {
    /* nothing to measure yet */
  }
}

function statusChipClass(status: string): string {
  if (status === 'success') return 'bg-success/15 text-success';
  if (status === 'killed') return 'bg-surface-3 text-ink-muted';
  return 'bg-danger/15 text-danger';
}

/**
 * xterm cannot read CSS variables — it paints to a canvas — so the two themes'
 * colours are repeated here, keyed by mode. Compiler diagnostics arrive as ANSI
 * escapes from gcc and javac, so the 8 base colours matter as much as the
 * background does.
 */
const TERMINAL_THEMES: Record<ThemeName, Record<string, string>> = {
  dark: {
    background: '#0d1117',
    foreground: '#e6edf3',
    cursor: '#2f81f7',
    selectionBackground: '#3392ff44',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#0969da',
    selectionBackground: '#0969da26',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#4d2d00',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
  },
};
