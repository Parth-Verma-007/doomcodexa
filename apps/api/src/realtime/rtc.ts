import type { Namespace, Socket } from 'socket.io';
import { LIMITS, type Ack, type RtcMediaState, type RtcPeer } from '@codexa/shared';
import { installAuth, ensureRole } from './socketAuth.js';
import { logger } from '../observability/logger.js';
import { connectedSockets } from '../observability/metrics.js';

/**
 * WebRTC signalling (§9).
 *
 * The server relays SDP and ICE and nothing else — media is peer-to-peer, so
 * voice and video cost zero server bandwidth. That is the whole reason for a
 * mesh rather than an SFU at this scale.
 *
 * The mesh is hard-capped at MAX_RTC_PEERS. Each peer holds N-1 connections and
 * uploads N-1 copies of its stream; past four that stops working on residential
 * upload and you need an SFU instead.
 */

const roomOf = (projectId: string) => `rtc:${projectId}`;

interface PeerState {
  projectId: string;
  media: RtcMediaState;
}

const peers = new WeakMap<Socket, PeerState>();

export function installRtcNamespace(namespace: Namespace): void {
  installAuth(namespace);

  namespace.on('connection', (socket) => {
    connectedSockets.inc({ namespace: 'rtc' });
    const log = logger.child({ socketId: socket.id, userId: socket.data.userId });

    socket.on('rtc:join', (payload, ack) => {
      void handleJoin(namespace, socket, payload, ack).catch((err) => {
        log.error({ err }, 'rtc:join failed');
        reply(ack, { ok: false, error: { code: 'internal', message: 'Could not join the call.' } });
      });
    });

    socket.on('rtc:leave', () => {
      void handleLeave(namespace, socket);
    });

    // Signalling relay. `to` is a socket id in the same call; we verify that
    // rather than trusting the client, or one peer could signal into any call.
    socket.on('rtc:offer', (payload) => relay(namespace, socket, 'rtc:offer', payload));
    socket.on('rtc:answer', (payload) => relay(namespace, socket, 'rtc:answer', payload));
    socket.on('rtc:ice', (payload) => relay(namespace, socket, 'rtc:ice', payload));

    socket.on('rtc:media-state', (payload) => {
      const state = peers.get(socket);
      if (!state || !payload?.media) return;
      state.media = normaliseMedia(payload.media);
      namespace
        .to(roomOf(state.projectId))
        .emit('rtc:media-state', { peerId: socket.id, media: state.media });
    });

    socket.on('disconnect', () => {
      connectedSockets.dec({ namespace: 'rtc' });
      void handleLeave(namespace, socket);
    });
  });
}

async function handleJoin(
  namespace: Namespace,
  socket: Socket,
  payload: { projectId?: string; media?: RtcMediaState } | undefined,
  ack: unknown,
): Promise<void> {
  const projectId = payload?.projectId;
  if (!projectId) {
    reply(ack, { ok: false, error: { code: 'bad_request', message: 'projectId is required.' } });
    return;
  }

  // Viewers may join the call — they can talk about code they cannot edit.
  if (!(await ensureRole(socket, projectId, 'viewer', 'rtc:join'))) {
    reply(ack, { ok: false, error: { code: 'forbidden', message: 'You cannot join this call.' } });
    return;
  }

  const room = roomOf(projectId);
  const existing = await namespace.in(room).fetchSockets();

  if (existing.length >= LIMITS.MAX_RTC_PEERS) {
    reply(ack, {
      ok: false,
      error: {
        code: 'conflict',
        message: `This call is full (${LIMITS.MAX_RTC_PEERS} people max).`,
      },
    });
    return;
  }

  const media = normaliseMedia(payload?.media);
  peers.set(socket, { projectId, media });
  await socket.join(room);

  const peerList: RtcPeer[] = existing.map((s) => ({
    peerId: s.id,
    user: s.data.user,
    media: normaliseMedia((s.data as { media?: RtcMediaState }).media),
  }));

  const me: RtcPeer = { peerId: socket.id, user: socket.data.user, media };
  socket.to(room).emit('rtc:peer-joined', { peer: me });

  reply(ack, { ok: true, data: { peerId: socket.id, peers: peerList } });
}

async function handleLeave(namespace: Namespace, socket: Socket): Promise<void> {
  const state = peers.get(socket);
  if (!state) return;
  peers.delete(socket);

  const room = roomOf(state.projectId);
  await socket.leave(room);
  namespace.to(room).emit('rtc:peer-left', { peerId: socket.id });
}

/**
 * Forward a signalling message to one specific peer.
 *
 * The sender supplies `to`; we check that the target is actually in the same
 * call before forwarding. Without that check, any authenticated user could
 * inject an offer into any call on the server.
 */
function relay(
  namespace: Namespace,
  socket: Socket,
  event: 'rtc:offer' | 'rtc:answer' | 'rtc:ice',
  payload: { to?: string; sdp?: string; candidate?: unknown } | undefined,
): void {
  const state = peers.get(socket);
  const to = payload?.to;
  if (!state || !to) return;

  const target = namespace.sockets.get(to);
  if (!target || !target.rooms.has(roomOf(state.projectId))) return;

  const body =
    event === 'rtc:ice'
      ? { from: socket.id, candidate: payload?.candidate }
      : { from: socket.id, sdp: payload?.sdp };

  target.emit(event, body);
}

function normaliseMedia(media: RtcMediaState | undefined): RtcMediaState {
  return {
    audio: Boolean(media?.audio),
    video: Boolean(media?.video),
    screen: Boolean(media?.screen),
  };
}

function reply(ack: unknown, response: Ack<unknown>): void {
  if (typeof ack === 'function') (ack as (r: unknown) => void)(response);
}
