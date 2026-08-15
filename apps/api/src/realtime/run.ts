import type { Namespace, Socket } from 'socket.io';
import { Types } from 'mongoose';
import { rooms, startRunSchema, type Ack, type RunEvent, type UserDto } from '@codexa/shared';
import { installAuth, ensureRole } from './socketAuth.js';
import { getExecutionEngine } from '../execution/index.js';
import {
  checkRunRateLimit,
  createRunRecord,
  makeRunRecorder,
  prepareRun,
} from '../services/runs.js';
import { Project, Run, toRunDto, User, toUserDto } from '../db/models/index.js';
import { ApiError } from '../http/errors.js';
import { logger } from '../observability/logger.js';
import { connectedSockets } from '../observability/metrics.js';
import type { RunHandle } from '../execution/types.js';

/**
 * The /run namespace (§8).
 *
 * Run events are broadcast to the whole project room, not just whoever pressed
 * the button — everyone sees the same terminal. That is the collaborative
 * point, and it is why the events carry a `runId`: two people can start runs
 * and the client keeps them apart.
 */

interface LiveRun {
  handle: RunHandle;
  projectId: string;
  /** Only the person who started a run may feed it stdin or kill it. */
  ownerId: string;
}

const live = new Map<string, LiveRun>();

export function installRunNamespace(namespace: Namespace): void {
  installAuth(namespace);

  namespace.on('connection', (socket) => {
    connectedSockets.inc({ namespace: 'run' });
    const log = logger.child({ socketId: socket.id, userId: socket.data.userId });

    socket.on('run:subscribe', (payload, ack) => {
      void handleSubscribe(socket, payload?.projectId, ack).catch((err) => {
        log.error({ err }, 'run:subscribe failed');
        reply(ack, { ok: false, error: { code: 'internal', message: 'Could not subscribe.' } });
      });
    });

    socket.on('run:start', (payload, ack) => {
      void handleStart(namespace, socket, payload, ack).catch((err) => {
        if (err instanceof ApiError) {
          reply(ack, { ok: false, error: { code: err.code, message: err.message } });
          return;
        }
        log.error({ err }, 'run:start failed');
        reply(ack, { ok: false, error: { code: 'internal', message: 'Could not start the run.' } });
      });
    });

    socket.on('run:stdin', (payload) => {
      const entry = payload?.runId ? live.get(payload.runId) : undefined;
      if (!entry || entry.ownerId !== socket.data.userId) return;
      entry.handle.writeStdin(payload.data ?? '');
    });

    socket.on('run:kill', (payload) => {
      const entry = payload?.runId ? live.get(payload.runId) : undefined;
      if (!entry || entry.ownerId !== socket.data.userId) return;
      void entry.handle.kill('Stopped by the user.');
    });

    socket.on('disconnect', () => {
      connectedSockets.dec({ namespace: 'run' });
      // Kill anything this socket owns. Otherwise closing the tab leaves a
      // container burning CPU until its wall-clock timeout.
      for (const [runId, entry] of live) {
        if (entry.ownerId !== socket.data.userId) continue;
        void entry.handle.kill('The person who started this run disconnected.');
        live.delete(runId);
      }
    });
  });
}

async function handleSubscribe(
  socket: Socket,
  projectId: string | undefined,
  ack: unknown,
): Promise<void> {
  if (!projectId) {
    reply(ack, { ok: false, error: { code: 'bad_request', message: 'projectId is required.' } });
    return;
  }
  if (!(await ensureRole(socket, projectId, 'viewer', 'run:subscribe'))) {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'Project not found.' } });
    return;
  }

  await socket.join(rooms.project(projectId));

  const runs = await Run.find({ projectId }).sort({ createdAt: -1 }).limit(20);
  const users = await User.find({ _id: { $in: runs.map((r) => r.triggeredBy) } });
  const byId = new Map(users.map((u) => [String(u._id), toUserDto(u)]));

  reply(ack, {
    ok: true,
    data: runs.map((r) => toRunDto(r, byId.get(String(r.triggeredBy)) ?? null)),
  });
}

async function handleStart(
  namespace: Namespace,
  socket: Socket,
  payload: unknown,
  ack: unknown,
): Promise<void> {
  const parsed = startRunSchema.safeParse(payload);
  if (!parsed.success) {
    reply(ack, {
      ok: false,
      error: { code: 'validation_failed', message: 'Invalid run request.' },
    });
    return;
  }
  const input = parsed.data;

  // Viewers may run code: reading a program and seeing what it does is part of
  // reading it. They still cannot change it.
  if (!(await ensureRole(socket, input.projectId, 'viewer', 'run:start'))) {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'Project not found.' } });
    return;
  }

  const engine = getExecutionEngine();
  if (!engine.isAvailable()) {
    reply(ack, {
      ok: false,
      error: {
        code: 'unavailable',
        message: engine.unavailableReason() ?? 'Execution is offline.',
      },
    });
    return;
  }

  const limit = checkRunRateLimit(socket.data.userId);
  if (!limit.allowed) {
    reply(ack, {
      ok: false,
      error: { code: 'rate_limited', message: limit.message ?? 'Slow down.' },
    });
    return;
  }

  const project = await Project.findById(input.projectId);
  if (!project) {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'Project not found.' } });
    return;
  }

  const runId = new Types.ObjectId().toHexString();
  const prepared = await prepareRun(project, runId, input.fileId, input.stdin, input.interactive);

  await createRunRecord({
    runId,
    projectId: input.projectId,
    userId: socket.data.userId,
    language: prepared.language,
    entrypoint: prepared.entrypointPath,
    ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
  });

  const room = rooms.project(input.projectId);
  const user = socket.data.user as UserDto;

  namespace.to(room).emit('run:started', {
    runId,
    by: user,
    language: prepared.language,
    entrypoint: prepared.entrypointPath,
    interactive: input.interactive,
  });

  const recorder = makeRunRecorder(runId);
  const sink = (event: RunEvent) => {
    recorder.observe(event);
    emitToRoom(namespace, room, runId, event);
  };

  const handle = await engine.run(prepared.spec, sink);
  live.set(runId, { handle, projectId: input.projectId, ownerId: socket.data.userId });

  // Non-interactive runs get their stdin up front; interactive ones receive it
  // keystroke by keystroke from the terminal.
  if (!input.interactive && input.stdin) {
    handle.writeStdin(input.stdin.endsWith('\n') ? input.stdin : `${input.stdin}\n`);
  }

  void handle.finished.finally(() => live.delete(runId));

  reply(ack, { ok: true, data: { runId } });
}

/** Map an engine event onto its socket event. */
function emitToRoom(namespace: Namespace, room: string, runId: string, event: RunEvent): void {
  const target = namespace.to(room);
  switch (event.type) {
    case 'queued':
      target.emit('run:queued', { runId, position: event.position });
      break;
    case 'status':
      target.emit('run:status', { runId, phase: event.phase });
      break;
    case 'stdout':
      target.emit('run:stdout', { runId, chunk: event.chunk });
      break;
    case 'stderr':
      target.emit('run:stderr', { runId, chunk: event.chunk });
      break;
    case 'truncated':
      target.emit('run:truncated', { runId, limitBytes: event.limitBytes });
      break;
    case 'exit':
      target.emit('run:exit', {
        runId,
        status: event.status,
        exitCode: event.exitCode,
        compileMs: event.compileMs,
        runMs: event.runMs,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      });
      break;
    default:
      break;
  }
}

function reply(ack: unknown, response: Ack<unknown>): void {
  if (typeof ack === 'function') (ack as (r: unknown) => void)(response);
}
