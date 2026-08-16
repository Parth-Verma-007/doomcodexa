import { createHash, randomBytes } from 'node:crypto';
import { Session, User, type UserDoc } from '../db/models/index.js';

/**
 * Session issuing and lookup.
 *
 * The token the client holds never reaches the database; its SHA-256 does. A
 * plain hash is the right primitive here rather than a password hash: the token
 * is 256 bits of randomness, so there is no dictionary to attack and no reason
 * to pay scrypt's cost on every single request.
 */

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How stale `lastUsedAt` may get before we spend a write refreshing it. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(user: UserDoc, userAgent?: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');

  await Session.create({
    tokenHash: hashToken(token),
    userId: user._id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    userAgent: userAgent?.slice(0, 200) ?? null,
  });

  return token;
}

/**
 * The user behind a token, or null.
 *
 * `expiresAt` is compared here as well as by the TTL index, because Mongo's
 * expiry sweep runs about once a minute — the index bounds how long a dead
 * session is *stored*, not how long it would be *accepted*.
 */
export async function resolveSession(token: string | undefined): Promise<UserDoc | null> {
  if (!token) return null;

  const session = await Session.findOne({ tokenHash: hashToken(token) });
  if (!session) return null;

  if (session.expiresAt.getTime() <= Date.now()) {
    await Session.deleteOne({ _id: session._id });
    return null;
  }

  const user = await User.findById(session.userId);
  if (!user) {
    // The account went away underneath the session.
    await Session.deleteOne({ _id: session._id });
    return null;
  }

  if (Date.now() - session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
    await Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } });
  }

  return user;
}

export async function revokeSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await Session.deleteOne({ tokenHash: hashToken(token) });
}

/** Used when a password changes: every other device should have to sign in again. */
export async function revokeAllSessionsFor(userId: unknown): Promise<void> {
  await Session.deleteMany({ userId });
}
