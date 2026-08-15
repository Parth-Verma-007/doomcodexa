import type { ReactNode } from 'react';
import {
  ClerkProvider,
  SignedIn as ClerkSignedIn,
  SignedOut as ClerkSignedOut,
  UserButton as ClerkUserButton,
  useAuth as useClerkAuth,
} from '@clerk/clerk-react';
import { env } from './env.js';

/**
 * A single seam over Clerk.
 *
 * Every component imports auth from here rather than from `@clerk/clerk-react`,
 * so the dev bypass exists in exactly one place — the same discipline the API
 * uses in `auth/clerk.ts`. Without this the app hard-depends on a Clerk account
 * just to render, which made the project impossible to run from a fresh clone.
 *
 * In bypass mode the "session token" is simply the identity string. The API,
 * when its own bypass is on, treats a socket token exactly that way, so the two
 * sides agree on who you are with no shared secret.
 */

export interface AuthState {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (env.devBypass) return <>{children}</>;

  return (
    <ClerkProvider
      publishableKey={env.clerkPublishableKey}
      afterSignOutUrl="/"
      appearance={{ variables: { colorPrimary: '#4c8dff' } }}
    >
      {children}
    </ClerkProvider>
  );
}

function useDevAuth(): AuthState {
  return {
    isLoaded: true,
    isSignedIn: true,
    getToken: async () => env.devUser,
  };
}

function useRealAuth(): AuthState {
  const { isLoaded, isSignedIn, getToken } = useClerkAuth();
  return {
    isLoaded,
    isSignedIn: Boolean(isSignedIn),
    getToken: () => getToken(),
  };
}

/**
 * Two implementations behind one name.
 *
 * The choice is bound once at module scope rather than branched inside the
 * hook. `env.devBypass` is a build-time constant so either form behaves
 * identically at runtime, but selecting here keeps the call below
 * unconditional — which is what the rules of hooks actually require, and means
 * the linter is checking something real rather than being silenced.
 */
const useAuthImplementation = env.devBypass ? useDevAuth : useRealAuth;

export function useAuthState(): AuthState {
  return useAuthImplementation();
}

export function SignedIn({ children }: { children: ReactNode }) {
  if (env.devBypass) return <>{children}</>;
  return <ClerkSignedIn>{children}</ClerkSignedIn>;
}

export function SignedOut({ children }: { children: ReactNode }) {
  if (env.devBypass) return null;
  return <ClerkSignedOut>{children}</ClerkSignedOut>;
}

export function UserButton() {
  if (!env.devBypass) return <ClerkUserButton afterSignOutUrl="/" />;

  // A visible, deliberately unpolished marker: you should never mistake a
  // bypassed session for a real one.
  return (
    <span
      title="Authentication is bypassed (VITE_AUTH_DEV_BYPASS=1)"
      className="flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] font-medium text-warning"
    >
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      {env.devUser}
    </span>
  );
}
