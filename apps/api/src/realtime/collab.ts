import type { Namespace, Socket } from 'socket.io';
import {
  LIMITS,
  rooms,
  sendMessageSchema,
  type Ack,
  type PresencePeer,
  type Role,
} from '@codexa/shared';
import { installAuth, ensureRole, resolveRole } from './socketAuth.js';
import * as docStore from './docStore.js';
import * as presence from './awareness.js';
import { File, Message, Project, toMessageDto, toProjectDto } from '../db/models/index.js';
import { logger } from '../observability/logger.js';
import { activeRooms, connectedSockets, rejectedUpdates } from '../observability/metrics.js';

/**
 * The /collab namespace: CRDT sync, presence and chat (§7).
 *
 * Sync protocol, per file room:
 *   client -> sync:step1 (its state vector)
 *   server -> sync:step2 (the diff it is missing)  + sync:step1 (server's SV)
 *   client -> sync:step2 (the diff the server is missing)
 *   both   -> sync:update (incremental, relayed to the room)
 *
 * On reconnect the client simply re-runs step 1 and Yjs merges both directions,
 * which is what makes offline edits survive for free.
 */

/** fileId -> projectId, for the files this socket has open. */
type OpenDocs = Map<string, string>;
const openDocsBySocket = new WeakMap<Socket, OpenDocs>();
/** Projects this socket has joined. */
const joinedProjects = new WeakMap<Socket, Set<string>>();

export function installCollabNamespace(namespace: Namespace): void {
  installAuth(namespace);

  namespace.on('connection', (socket) => {
    connectedSockets.inc({ namespace: 'collab' });
    openDocsBySocket.set(socket, new Map());
    joinedProjects.set(socket, new Set());

    const log = logger.child({ socketId: socket.id, userId: socket.data.userId });

    socket.on('room:join', (payload, ack) => {
      void handleJoin(namespace, socket, payload?.projectId, ack).catch((err) => {
        log.error({ err }, 'room:join failed');
        reply(ack, { ok: false, error: { code: 'internal', message: 'Could not join project.' } });
      });
    });

    socket.on('room:leave', (payload) => {
      void handleLeave(namespace, socket, payload?.projectId);
    });

    socket.on('doc:open', (payload, ack) => {
      void handleDocOpen(socket, payload?.fileId, ack).catch((err) => {
        log.error({ err, fileId: payload?.fileId }, 'doc:open failed');
        reply(ack, { ok: false, error: { code: 'internal', message: 'Could not open file.' } });
      });
    });

    socket.on('doc:close', (payload) => {
      void handleDocClose(socket, payload?.fileId);
    });

    socket.on('sync:step1', (payload) => {
      void handleStep1(socket, payload).catch((err) => log.error({ err }, 'sync:step1 failed'));
    });

    // step2 carries the diff the client had that the server lacked. It is an
    // update like any other, so it takes the same path — including the size
    // check and the role check.
    socket.on('sync:step2', (payload) => {
      void handleUpdate(namespace, socket, payload).catch((err) =>
        log.error({ err }, 'sync:step2 failed'),
      );
    });

    socket.on('sync:update', (payload) => {
      void handleUpdate(namespace, socket, payload).catch((err) =>
        log.error({ err }, 'sync:update failed'),
      );
    });

    socket.on('awareness:update', (payload) => {
      void handleAwareness(namespace, socket, payload).catch((err) =>
        log.error({ err }, 'awareness:update failed'),
      );
    });

    socket.on('chat:send', (payload, ack) => {
      void handleChat(namespace, socket, payload, ack).catch((err) => {
        log.error({ err }, 'chat:send failed');
        reply(ack, { ok: false, error: { code: 'internal', message: 'Message not sent.' } });
      });
    });

    socket.on('disconnect', (reason) => {
      connectedSockets.dec({ namespace: 'collab' });
      void handleDisconnect(namespace, socket).catch((err) =>
        log.error({ err, reason }, 'disconnect cleanup failed'),
      );
    });
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleJoin(
  namespace: Namespace,
  socket: Socket,
  projectId: string | undefined,
  ack: unknown,
): Promise<void> {
  if (!projectId) {
    reply(ack, { ok: false, error: { code: 'bad_request', message: 'projectId is required.' } });
    return;
  }

  const role = await resolveRole(socket, projectId);
  if (!role) {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'Project not found.' } });
    return;
  }

  const project = await Project.findById(projectId);
  if (!project) {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'Project not found.' } });
    return;
  }

  const room = rooms.project(projectId);
  await socket.join(room);
  joinedProjects.get(socket)?.add(projectId);

  const peers = await peersIn(namespace, projectId, socket.id);

  const me: PresencePeer = {
    socketId: socket.id,
    user: socket.data.user,
    role,
    activeFileId: null,
  };
  socket.to(room).emit('peer:joined', { peer: me });

  // Hand the newcomer everyone's current cursors immediately, rather than
  // waiting for each peer's next keystroke.
  const snapshot = presence.snapshotFor(projectId);
  if (snapshot) socket.emit('awareness:update', { update: snapshot });

  activeRooms.set(presence.activeProjectCount());

  reply(ack, {
    ok: true,
    data: { project: toProjectDto(project, role), role, peers },
  });
}

async function handleLeave(
  namespace: Namespace,
  socket: Socket,
  projectId: string | undefined,
): Promise<void> {
  if (!projectId) return;

  const room = rooms.project(projectId);
  await socket.leave(room);
  joinedProjects.get(socket)?.delete(projectId);

  const removal = presence.removeSocket(projectId, socket.id);
  if (removal) namespace.to(room).emit('awareness:update', { update: removal });
  namespace.to(room).emit('peer:left', { socketId: socket.id, userId: socket.data.userId });

  // Release any docs this socket had open in that project.
  const open = openDocsBySocket.get(socket);
  if (open) {
    for (const [fileId, ownerProject] of open) {
      if (ownerProject !== projectId) continue;
      open.delete(fileId);
      await docStore.unsubscribe(fileId);
      await socket.leave(rooms.file(projectId, fileId));
    }
  }
}

async function handleDocOpen(
  socket: Socket,
  fileId: string | undefined,
  ack: unknown,
): Promise<void> {
  if (!fileId) {
    reply(ack, { ok: false, error: { code: 'bad_request', message: 'fileId is required.' } });
    return;
  }

  const file = await File.findById(fileId).select('projectId type');
  if (!file || file.type !== 'file') {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'File not found.' } });
    return;
  }

  const projectId = String(file.projectId);
  // Viewer is enough to read a document; editing is gated per update.
  if (!(await ensureRole(socket, projectId, 'viewer', 'doc:open'))) {
    reply(ack, { ok: false, error: { code: 'not_found', message: 'File not found.' } });
    return;
  }

  const open = openDocsBySocket.get(socket);
  if (open?.has(fileId)) {
    reply(ack, { ok: true, data: { fileId } });
    return;
  }

  const stateVector = await docStore.subscribe(fileId, projectId);
  open?.set(fileId, projectId);
  await socket.join(rooms.file(projectId, fileId));

  reply(ack, { ok: true, data: { fileId } });

  // Kick off the handshake from the server side: the client answers with the
  // diff we are missing, so a reconnecting client's offline edits arrive.
  socket.emit('sync:step1', { fileId, stateVector });
}

async function handleDocClose(socket: Socket, fileId: string | undefined): Promise<void> {
  if (!fileId) return;
  const open = openDocsBySocket.get(socket);
  const projectId = open?.get(fileId);
  if (!projectId) return;

  open?.delete(fileId);
  await socket.leave(rooms.file(projectId, fileId));
  await docStore.unsubscribe(fileId);
}

async function handleStep1(
  socket: Socket,
  payload: { fileId?: string; stateVector?: Uint8Array } | undefined,
): Promise<void> {
  const fileId = payload?.fileId;
  const stateVector = payload?.stateVector;
  if (!fileId || !stateVector) return;

  const projectId = openDocsBySocket.get(socket)?.get(fileId);
  if (!projectId) return; // not subscribed — ignore rather than trust the payload

  const update = await docStore.diffSince(fileId, projectId, toUint8(stateVector));
  socket.emit('sync:step2', { fileId, update });
}

async function handleUpdate(
  namespace: Namespace,
  socket: Socket,
  payload: { fileId?: string; update?: Uint8Array } | undefined,
): Promise<void> {
  const fileId = payload?.fileId;
  const update = payload?.update;
  if (!fileId || !update) return;

  const projectId = openDocsBySocket.get(socket)?.get(fileId);
  if (!projectId) return;

  // The check that makes read-only real: a viewer's socket can emit this, so
  // the role is verified here rather than assumed from the join.
  if (!(await ensureRole(socket, projectId, 'editor', 'sync:update'))) {
    rejectedUpdates.inc({ reason: 'forbidden' });
    return;
  }

  const bytes = toUint8(update);

  try {
    await docStore.applyUpdate(fileId, projectId, bytes);
  } catch (err) {
    if (err instanceof docStore.DocumentTooLargeError) {
      rejectedUpdates.inc({ reason: 'too_large' });
      socket.emit('codexa:error', {
        code: 'payload_too_large',
        message: `That edit is too large. Files are limited to ${Math.floor(LIMITS.MAX_DOC_BYTES / 1024 / 1024)} MB.`,
        context: 'sync:update',
      });
      return;
    }
    throw err;
  }

  // Relay only after the server has accepted it, so a rejected update never
  // reaches other clients and the room cannot diverge from the snapshot.
  socket.to(rooms.file(projectId, fileId)).emit('sync:update', { fileId, update: bytes });
  void namespace;
}

async function handleAwareness(
  namespace: Namespace,
  socket: Socket,
  payload: { projectId?: string; update?: Uint8Array } | undefined,
): Promise<void> {
  const projectId = payload?.projectId;
  const update = payload?.update;
  if (!projectId || !update) return;
  if (!joinedProjects.get(socket)?.has(projectId)) return;

  const relayed = presence.applyAwarenessUpdate(projectId, socket.id, toUint8(update));
  if (!relayed) return;

  socket.to(rooms.project(projectId)).emit('awareness:update', { update: relayed });
  void namespace;
}

async function handleChat(
  namespace: Namespace,
  socket: Socket,
  payload: { projectId?: string; body?: string } | undefined,
  ack: unknown,
): Promise<void> {
  const projectId = payload?.projectId;
  if (!projectId) {
    reply(ack, { ok: false, error: { code: 'bad_request', message: 'projectId is required.' } });
    return;
  }

  // Viewers can chat — they can talk about the code they cannot edit.
  if (!(await ensureRole(socket, projectId, 'viewer', 'chat:send'))) {
    reply(ack, { ok: false, error: { code: 'forbidden', message: 'You cannot post here.' } });
    return;
  }

  const parsed = sendMessageSchema.safeParse({ body: payload?.body });
  if (!parsed.success) {
    reply(ack, {
      ok: false,
      error: { code: 'validation_failed', message: 'Message is empty or too long.' },
    });
    return;
  }

  const message = await Message.create({
    projectId,
    authorId: socket.data.userId,
    body: parsed.data.body,
  });

  const dto = toMessageDto(message, socket.data.user);
  namespace.to(rooms.project(projectId)).emit('chat:message', { message: dto });
  reply(ack, { ok: true, data: dto });
}

async function handleDisconnect(namespace: Namespace, socket: Socket): Promise<void> {
  const open = openDocsBySocket.get(socket);
  if (open) {
    for (const fileId of open.keys()) {
      await docStore.unsubscribe(fileId);
    }
    open.clear();
  }

  for (const projectId of joinedProjects.get(socket) ?? []) {
    const room = rooms.project(projectId);
    const removal = presence.removeSocket(projectId, socket.id);
    if (removal) namespace.to(room).emit('awareness:update', { update: removal });
    namespace.to(room).emit('peer:left', { socketId: socket.id, userId: socket.data.userId });
  }
  joinedProjects.get(socket)?.clear();

  activeRooms.set(presence.activeProjectCount());
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function peersIn(
  namespace: Namespace,
  projectId: string,
  excludeSocketId: string,
): Promise<PresencePeer[]> {
  const sockets = await namespace.in(rooms.project(projectId)).fetchSockets();
  return sockets
    .filter((s) => s.id !== excludeSocketId)
    .map((s) => ({
      socketId: s.id,
      user: s.data.user,
      role: (s.data.roles?.get(projectId) ?? 'viewer') as Role,
      activeFileId: null,
    }));
}

/**
 * Socket.IO delivers binary as Buffer on Node and ArrayBuffer in some paths.
 * Yjs requires a real Uint8Array view, and a Buffer that is a slice of a larger
 * pool decodes as garbage if handed over directly.
 */
function toUint8(value: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function reply(ack: unknown, response: Ack<unknown>): void {
  if (typeof ack === 'function') (ack as (r: unknown) => void)(response);
}
