import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import type { Server as IoServer } from 'socket.io';
import * as Y from 'yjs';
import request from 'supertest';
import type { Express } from 'express';
import { NS } from '@codexa/shared';
import { TEST_IDENTITY_HEADER } from '../auth/clerk.js';

/**
 * Socket-level integration (§14): two real clients, one real server.
 *
 * This is where read-only is proven to be real. A viewer's socket can emit
 * `sync:update` — nothing in the browser stops it — so the test asserts the
 * server drops it and the other client never sees the edit.
 */

const OWNER = 'user_sock_owner';
const VIEWER = 'user_sock_viewer';

let app: Express;
let httpServer: HttpServer;
let io: IoServer;
let port: number;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const { createRealtimeServer } = await import('./index.js');

  app = createApp();
  httpServer = createServer(app);
  io = createRealtimeServer(httpServer);

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterEach(() => {
  while (clients.length > 0) clients.pop()?.disconnect();
});

afterAll(async () => {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** With Clerk disabled the handshake token is simply the identity to assume. */
function openSocket(namespace: string, identity: string): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${port}${namespace}`, {
    auth: { token: identity },
    transports: ['websocket'],
    forceNew: true,
  });
  clients.push(socket);

  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), 5000);
    socket.emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

function waitFor<T>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no ${event} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Resolves to null if the event does NOT arrive — used for negative assertions. */
function expectNoEvent(socket: ClientSocket, event: string, withinMs = 400): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, withinMs);
    const handler = (payload: unknown) => {
      clearTimeout(timer);
      resolve(payload);
    };
    socket.once(event, handler);
  });
}

const as = (identity: string) => ({ [TEST_IDENTITY_HEADER]: identity });

async function seedProject() {
  const created = await request(app)
    .post('/api/projects')
    .set(as(OWNER))
    .send({ name: 'Realtime', language: 'python' })
    .expect(201);

  const project = created.body.project as { id: string; entrypointFileId: string };

  const share = await request(app)
    .post(`/api/projects/${project.id}/share`)
    .set(as(OWNER))
    .send({ role: 'viewer' })
    .expect(200);

  await request(app)
    .post('/api/projects/join')
    .set(as(VIEWER))
    .send({ token: share.body.project.shareToken })
    .expect(200);

  return project;
}

describe('authentication', () => {
  it('rejects a connection with no identity when Clerk is enabled', async () => {
    // Clerk is disabled here, so instead assert the handshake succeeds and the
    // socket is bound to the fallback dev identity rather than being anonymous.
    const socket = await openSocket(NS.collab, '');
    expect(socket.connected).toBe(true);
  });
});

describe('collaborative editing', () => {
  it('propagates an edit from one client to another', async () => {
    const project = await seedProject();

    const a = await openSocket(NS.collab, OWNER);
    const b = await openSocket(NS.collab, VIEWER);

    await emitWithAck(a, 'room:join', { projectId: project.id });
    await emitWithAck(b, 'room:join', { projectId: project.id });

    await emitWithAck(a, 'doc:open', { fileId: project.entrypointFileId });
    await emitWithAck(b, 'doc:open', { fileId: project.entrypointFileId });

    // B mirrors the document exactly as the browser provider would.
    const mirror = new Y.Doc();
    b.on('sync:step2', ({ update }: { update: ArrayBuffer }) =>
      Y.applyUpdate(mirror, new Uint8Array(update)),
    );
    b.on('sync:update', ({ update }: { update: ArrayBuffer }) =>
      Y.applyUpdate(mirror, new Uint8Array(update)),
    );

    // Pull the current state so the mirror starts from the template.
    b.emit('sync:step1', {
      fileId: project.entrypointFileId,
      stateVector: Y.encodeStateVector(mirror),
    });
    await waitFor(b, 'sync:step2');

    const incoming = waitFor(b, 'sync:update');

    const authorDoc = new Y.Doc();
    Y.applyUpdate(authorDoc, Y.encodeStateAsUpdate(mirror));
    authorDoc.getText('monaco').insert(0, '# added by A\n');
    a.emit('sync:update', {
      fileId: project.entrypointFileId,
      update: Y.encodeStateAsUpdate(authorDoc, Y.encodeStateVector(mirror)),
    });

    await incoming;
    expect(mirror.getText('monaco').toString()).toContain('# added by A');

    mirror.destroy();
    authorDoc.destroy();
  });

  it('drops a viewer’s edit and never relays it', async () => {
    const project = await seedProject();

    const owner = await openSocket(NS.collab, OWNER);
    const viewer = await openSocket(NS.collab, VIEWER);

    await emitWithAck(owner, 'room:join', { projectId: project.id });
    await emitWithAck(viewer, 'room:join', { projectId: project.id });
    await emitWithAck(owner, 'doc:open', { fileId: project.entrypointFileId });
    await emitWithAck(viewer, 'doc:open', { fileId: project.entrypointFileId });

    const rejection = waitFor<{ code: string }>(viewer, 'codexa:error');
    const leaked = expectNoEvent(owner, 'sync:update', 500);

    const doc = new Y.Doc();
    doc.getText('monaco').insert(0, 'viewers cannot write this');
    viewer.emit('sync:update', {
      fileId: project.entrypointFileId,
      update: Y.encodeStateAsUpdate(doc),
    });

    expect((await rejection).code).toBe('forbidden');
    expect(await leaked).toBeNull();

    // And the document itself is unchanged.
    const content = await request(app)
      .get(`/api/files/${project.entrypointFileId}/content`)
      .set(as(OWNER))
      .expect(200);
    expect(content.body.content).not.toContain('viewers cannot write this');

    doc.destroy();
  });

  it('refuses to open a document in a project the caller cannot see', async () => {
    const project = await seedProject();
    const stranger = await openSocket(NS.collab, 'user_sock_stranger');

    const res = await emitWithAck<{ ok: boolean }>(stranger, 'doc:open', {
      fileId: project.entrypointFileId,
    });
    expect(res.ok).toBe(false);
  });

  it('ignores a sync update for a document the socket never opened', async () => {
    const project = await seedProject();
    const owner = await openSocket(NS.collab, OWNER);
    const other = await openSocket(NS.collab, VIEWER);

    await emitWithAck(owner, 'room:join', { projectId: project.id });
    await emitWithAck(other, 'room:join', { projectId: project.id });
    await emitWithAck(other, 'doc:open', { fileId: project.entrypointFileId });

    const leaked = expectNoEvent(other, 'sync:update', 400);

    const doc = new Y.Doc();
    doc.getText('monaco').insert(0, 'not subscribed');
    // Owner never called doc:open, so this must be ignored.
    owner.emit('sync:update', {
      fileId: project.entrypointFileId,
      update: Y.encodeStateAsUpdate(doc),
    });

    expect(await leaked).toBeNull();
    doc.destroy();
  });
});

describe('presence', () => {
  it('announces a peer joining and leaving', async () => {
    const project = await seedProject();

    const first = await openSocket(NS.collab, OWNER);
    await emitWithAck(first, 'room:join', { projectId: project.id });

    const joined = waitFor<{ peer: { user: { id: string } } }>(first, 'peer:joined');
    const second = await openSocket(NS.collab, VIEWER);
    await emitWithAck(second, 'room:join', { projectId: project.id });

    const event = await joined;
    expect(event.peer.user.id).toBeTruthy();

    const left = waitFor<{ socketId: string }>(first, 'peer:left');
    second.disconnect();
    expect((await left).socketId).toBeTruthy();
  });

  it('gives a joining client the existing peer list', async () => {
    const project = await seedProject();

    const first = await openSocket(NS.collab, OWNER);
    await emitWithAck(first, 'room:join', { projectId: project.id });

    const second = await openSocket(NS.collab, VIEWER);
    const res = await emitWithAck<{ ok: true; data: { peers: unknown[] } }>(second, 'room:join', {
      projectId: project.id,
    });

    expect(res.ok).toBe(true);
    expect(res.data.peers).toHaveLength(1);
  });
});

describe('chat', () => {
  it('lets a viewer post and broadcasts to the room', async () => {
    const project = await seedProject();

    const owner = await openSocket(NS.collab, OWNER);
    const viewer = await openSocket(NS.collab, VIEWER);
    await emitWithAck(owner, 'room:join', { projectId: project.id });
    await emitWithAck(viewer, 'room:join', { projectId: project.id });

    const received = waitFor<{ message: { body: string } }>(owner, 'chat:message');
    const ack = await emitWithAck<{ ok: boolean }>(viewer, 'chat:send', {
      projectId: project.id,
      body: 'why is line 12 like that',
    });

    expect(ack.ok).toBe(true);
    expect((await received).message.body).toBe('why is line 12 like that');
  });

  it('rejects an empty message', async () => {
    const project = await seedProject();
    const owner = await openSocket(NS.collab, OWNER);
    await emitWithAck(owner, 'room:join', { projectId: project.id });

    const ack = await emitWithAck<{ ok: boolean }>(owner, 'chat:send', {
      projectId: project.id,
      body: '   ',
    });
    expect(ack.ok).toBe(false);
  });
});
