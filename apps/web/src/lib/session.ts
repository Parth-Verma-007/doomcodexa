import type { UserDto } from '@codexa/shared';

/**
 * The stored session, outside React.
 *
 * The socket manager and the REST client both need the current token, and
 * neither is a component — so the token cannot live only in component state.
 * This module owns it, persists it, and lets React subscribe.
 *
 * `localStorage`, so a reload keeps you signed in. Two identities on one machine
 * therefore need two browser profiles or an incognito window; the previous
 * per-tab trick only worked because there was no real credential to speak of.
 */

export interface StoredSession {
  token: string;
  user: UserDto;
  email: string;
}

const KEY = 'codexa-session';

let current: StoredSession | null = read();
const listeners = new Set<() => void>();

function read(): StoredSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    // Anything could be in storage — an older shape, or hand-edited nonsense.
    // A malformed entry must read as "signed out", never crash the app at boot.
    if (typeof parsed?.token !== 'string' || !parsed.user) return null;
    return parsed as StoredSession;
  } catch {
    return null;
  }
}

export function getSession(): StoredSession | null {
  return current;
}

export function getToken(): string | null {
  return current?.token ?? null;
}

export function setSession(session: StoredSession | null): void {
  current = session;
  try {
    if (session) localStorage.setItem(KEY, JSON.stringify(session));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode, or storage full. The in-memory session still works for
    // this page load, which is better than refusing to sign in at all.
  }
  for (const listener of listeners) listener();
}

/** `useSyncExternalStore` contract, so React re-renders when this changes. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
