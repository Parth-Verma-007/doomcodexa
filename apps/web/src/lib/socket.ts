import { io, type Socket } from 'socket.io-client';
import { NS } from '@codexa/shared';
import { env } from './env.js';

/**
 * Socket connection management.
 *
 * The important part is token refresh. Clerk session tokens live about a
 * minute; when one expires mid-session the handshake fails and a naive client
 * either gives up or reconnect-loops forever. The server distinguishes
 * `token_expired` from `invalid_token`, and this module reacts by fetching a
 * fresh token and reconnecting — which is why a Codexa tab left open over lunch
 * still works.
 */

type TokenGetter = () => Promise<string | null>;

let getToken: TokenGetter = async () => null;

export function registerSocketTokenGetter(getter: TokenGetter): void {
  getToken = getter;
}

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
    // The token is fetched fresh on every connection attempt, so a reconnect
    // after a long idle never presents a stale one.
    auth: (callback) => {
      void getToken()
        .then((token) => callback({ token: token ?? '' }))
        .catch(() => callback({ token: '' }));
    },
  });

  socket.on('connect', () => setStatus('connected'));

  socket.on('disconnect', (reason) => {
    // An explicit server-side disconnect is not something to retry blindly.
    setStatus(reason === 'io server disconnect' ? 'offline' : 'reconnecting');
  });

  socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));

  socket.on('connect_error', (err: Error & { data?: { reason?: string } }) => {
    const reason = err.data?.reason;
    if (reason === 'token_expired' || reason === 'missing_token') {
      // Expected: fetch a new token and try again immediately rather than
      // waiting out the backoff or bouncing the user to sign-in.
      void getToken().then(() => {
        if (!socket.connected) socket.connect();
      });
      setStatus('reconnecting');
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
