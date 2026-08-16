import type { SignInInput, SignUpInput } from '@codexa/shared';
import { CI, User, colorForKey, type UserDoc } from '../db/models/index.js';
import { ApiError } from '../http/errors.js';
import { equivalentWorkForMissingUser, hashPassword, verifyPassword } from './password.js';

/**
 * Registration and sign-in.
 *
 * Both paths are written so that failure reveals as little as the product will
 * tolerate. Sign-in never says which half was wrong and spends the same time on
 * a missing account as a real one; sign-up does say which field is taken,
 * because a registration form that will not tell you your email is already
 * registered is unusable — and the sign-in page would leak it anyway.
 */

const DUPLICATE_KEY = 11000;

export async function signUp(input: SignUpInput): Promise<UserDoc> {
  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);

  try {
    return await User.create({
      email,
      username: input.username,
      passwordHash,
      color: colorForKey(email),
    });
  } catch (err) {
    // The unique indexes are the authority, not a prior existence check: two
    // simultaneous sign-ups would both pass a check and one would still fail
    // here. Reading the index name tells us which field collided.
    if ((err as { code?: number }).code === DUPLICATE_KEY) {
      const key = String((err as { message?: string }).message ?? '');
      throw ApiError.conflict(
        key.includes('username')
          ? 'That username is taken.'
          : 'An account already exists for that email.',
      );
    }
    throw err;
  }
}

/**
 * Verify a credential.
 *
 * Returns null rather than throwing so the route decides the message, and
 * always performs a password hash — including when no such user exists — so
 * response time does not disclose which emails are registered.
 */
export async function signIn(input: SignInInput): Promise<UserDoc | null> {
  const identifier = input.identifier.trim();

  const user = await User.findOne({
    $or: [{ email: identifier }, { username: identifier }],
  })
    .collation(CI)
    .select('+passwordHash');

  if (!user) {
    await equivalentWorkForMissingUser(input.password);
    return null;
  }

  const ok = await verifyPassword(input.password, user.passwordHash);
  if (!ok) return null;

  // Re-read without the hash rather than deleting it from this document: an
  // unset required field on a live document is a save() away from a confusing
  // validation error, and nothing should carry the credential past this line.
  return User.findById(user._id);
}
