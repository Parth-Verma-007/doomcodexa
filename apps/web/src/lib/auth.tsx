import { useCallback, useSyncExternalStore, type ReactNode } from 'react';
import type { SignInInput, SignUpInput, UserDto } from '@codexa/shared';
import { api } from './api.js';
import { disconnectAll } from './socket.js';
import { getSession, setSession, subscribe } from './session.js';

/**
 * Authentication, owned by Codexa.
 *
 * This used to be a seam over Clerk with a development bypass behind it. The
 * app now issues its own sessions, so there is one code path instead of two and
 * nothing to accidentally leave switched on in production.
 *
 * The shape of `useAuthState` is unchanged on purpose — the router, the REST
 * client and the socket manager all consumed it and none of them had to care
 * where a token comes from.
 */

export interface AuthState {
  /**
   * Always true today — the session is read from storage synchronously before
   * the first render, so there is no loading state. Kept because the router
   * branches on it and a future token-refresh flow would reintroduce one.
   */
  isLoaded: boolean;
  isSignedIn: boolean;
  user: UserDto | null;
  email: string | null;
}

function useStoredSession() {
  return useSyncExternalStore(subscribe, getSession, () => null);
}

export function useAuthState(): AuthState {
  const session = useStoredSession();

  return {
    isLoaded: true,
    isSignedIn: session !== null,
    user: session?.user ?? null,
    email: session?.email ?? null,
  };
}

/** Sign in, sign up and sign out. Separate from `useAuthState` because most
 *  components only ever read. */
export function useAuthActions() {
  const signIn = useCallback(async (input: SignInInput) => {
    setSession(await api.login(input));
  }, []);

  const signUp = useCallback(async (input: SignUpInput) => {
    setSession(await api.signup(input));
  }, []);

  const signOut = useCallback(async () => {
    try {
      // Best effort: the server should forget the session too, but a network
      // failure must not leave the user stuck signed in on this device.
      await api.logout();
    } catch {
      /* ignore */
    }
    setSession(null);
    // Sockets authenticate at handshake, so an open one outlives sign-out
    // until something forces it closed.
    disconnectAll();
  }, []);

  return { signIn, signUp, signOut };
}

/** Render only when signed in. */
export function SignedIn({ children }: { children: ReactNode }) {
  return useStoredSession() ? <>{children}</> : null;
}

/** Render only when signed out. */
export function SignedOut({ children }: { children: ReactNode }) {
  return useStoredSession() ? null : <>{children}</>;
}
