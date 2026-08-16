import { io, type Socket } from 'socket.io-client';
import { NS } from '@codexa/shared';
import { env } from './env.js';
import { getToken } from './session.js';

/**
 * Socket connection management.
 *
 * The token is read at every connection attempt rather than captured once, so a
 * reconnect after a long idle presents whatever is current — including a token
 * from a sign-in that happened after this socket was created.
 *
 * Sessions last thirty days, so the old expiry-refresh dance is gone. What
 * remains is the distinction the server still draws: a handshake refused for a
 * missing or dead session should not be retried in a loop, because retrying
 * with the same dead token cannot succeed.
 */

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

const sockets = new Map<string, Socket>();
const statusListeners = new Set<(status: ConnectionStatus) => void>();
let status: ConnectionStatus = 'connecting';

function setStatus(next: ConnectionStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(next);
}

export function onConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

export function getConnectionStatus(): ConnectionStatus {
  return status;
}

/**
 * Get (or open) the socket for a namespace. Namespaces multiplex over one
 * physical connection, so calling this for all three is cheap.
 */
export function getSocket(namespace: string): Socket {
  const existing = sockets.get(namespace);
  if (existing) return existing;

  const socket = io(`${env.apiUrl}${namespace}`, {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    // Read fresh on every connection attempt, so a reconnect never presents a
    // token from before the last sign-in.
    auth: (callback) => callback({ token: getToken() ?? '' }),
  });

  socket.on('connect', () => setStatus('connected'));

  socket.on('disconnect', (reason) => {
    // An explicit server-side disconnect is not something to retry blindly.
    setStatus(reason === 'io server disconnect' ? 'offline' : 'reconnecting');
  });

  socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));

  socket.on('connect_error', (err: Error & { data?: { reason?: string } }) => {
    const reason = err.data?.reason;
    if (reason === 'missing_token' || reason === 'invalid_token') {
      // The session is gone. Retrying presents the same dead token, so stop and
      // let the UI show a disconnected state rather than spin forever.
      setStatus('offline');
      socket.disconnect();
      return;
    }
    setStatus('offline');
  });

  sockets.set(namespace, socket);
  return socket;
}

export const collabSocket = () => getSocket(NS.collab);
export const runSocket = () => getSocket(NS.run);
export const rtcSocket = () => getSocket(NS.rtc);

/** Tear everything down — used on sign-out so the next user starts clean. */
export function disconnectAll(): void {
  for (const socket of sockets.values()) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  sockets.clear();
  setStatus('offline');
}

/** Promise wrapper for an event that expects an acknowledgement. */
export function emitWithAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), timeoutMs);
    socket.emit(event, payload, (response: T) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}
