import { clerkClient, clerkMiddleware, getAuth } from '@clerk/express';
import type { RequestHandler } from 'express';
import { config } from '../config.js';
import { logger } from '../observability/logger.js';

/**
 * Clerk integration (§10).
 *
 * Everything funnels through `verifySessionToken` / `clerkAuthMiddleware` so the
 * dev bypass exists in exactly one place and cannot be forgotten somewhere else.
 */

/** The fixed identity used when AUTH_DEV_BYPASS=1. Never reachable in production. */
export const DEV_USER = {
  clerkId: 'user_dev_bypass',
  email: 'dev@codexa.local',
  username: 'dev',
  avatarUrl: null as string | null,
};

export interface VerifiedIdentity {
  clerkId: string;
}

/** Express middleware that populates Clerk's auth context, or no-ops in bypass mode. */
export function clerkAuthMiddleware(): RequestHandler {
  if (!config.auth.clerkEnabled) {
    logger.warn(
      { devBypass: config.auth.devBypass },
      'Clerk is disabled — every request resolves to the dev user',
    );
    return (_req, _res, next) => next();
  }
  return clerkMiddleware({
    secretKey: config.auth.secretKey,
    publishableKey: config.auth.publishableKey,
  });
}

/**
 * Header that selects an identity while Clerk is disabled.
 *
 * Without it the bypass yields one fixed user, and no test could exercise the
 * thing most worth testing — that a viewer cannot edit and a stranger gets a
 * 404. It is only ever consulted when `clerkEnabled` is false, and the config
 * module refuses to boot in production in that state.
 */
export const TEST_IDENTITY_HEADER = 'x-codexa-test-user';

/** The Clerk user id on a request, or null when unauthenticated. */
export function clerkIdFromRequest(req: Parameters<typeof getAuth>[0]): string | null {
  if (!config.auth.clerkEnabled) {
    const override = (req as { headers?: Record<string, unknown> }).headers?.[TEST_IDENTITY_HEADER];
    return typeof override === 'string' && override.length > 0 ? override : DEV_USER.clerkId;
  }
  try {
    return getAuth(req).userId ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify a raw session JWT. Used by the Socket.IO handshake, which has no
 * Express request to hang Clerk's middleware off.
 *
 * Clerk session tokens are short-lived (~60s); the client refreshes and
 * reconnects on `token_expired` (§10).
 */
export async function verifySessionToken(token: string | undefined): Promise<VerifiedIdentity> {
  if (!config.auth.clerkEnabled) {
    // With Clerk off, the socket's "token" is simply the identity to assume,
    // which is what lets a test open two sockets as two different people.
    return { clerkId: token && token.length > 0 ? token : DEV_USER.clerkId };
  }
  if (!token) {
    throw new TokenError('missing_token', 'No session token supplied.');
  }

  try {
    const { verifyToken } = await import('@clerk/express');
    const payload = await verifyToken(token, { secretKey: config.auth.secretKey });
    if (!payload.sub) throw new TokenError('invalid_token', 'Token has no subject.');
    return { clerkId: payload.sub };
  } catch (err) {
    if (err instanceof TokenError) throw err;
    const message = err instanceof Error ? err.message : 'Token verification failed.';
    // Distinguish expiry so the client knows to refresh rather than sign out.
    const expired = /expired/i.test(message);
    throw new TokenError(expired ? 'token_expired' : 'invalid_token', message);
  }
}

export class TokenError extends Error {
  readonly reason: 'missing_token' | 'invalid_token' | 'token_expired';
  constructor(reason: TokenError['reason'], message: string) {
    super(message);
    this.name = 'TokenError';
    this.reason = reason;
  }
}

/** Fetch a Clerk user's profile. Used when a socket connects before the webhook lands. */
export async function fetchClerkProfile(clerkId: string) {
  if (!config.auth.clerkEnabled) {
    // Derive a distinct profile per id so multi-user tests produce
    // distinguishable names and presence colours.
    const handle = clerkId === DEV_USER.clerkId ? DEV_USER.username : clerkId;
    return {
      email: `${handle}@codexa.local`,
      username: handle,
      avatarUrl: null,
    };
  }
  const user = await clerkClient.users.getUser(clerkId);
  const email =
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    `${clerkId}@unknown.local`;
  return {
    email,
    username:
      user.username ||
      [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      email.split('@')[0] ||
      'user',
    avatarUrl: user.imageUrl ?? null,
  };
}
