import { User, colorForClerkId, type UserDoc } from '../db/models/index.js';
import { fetchClerkProfile } from './clerk.js';
import { logger } from '../observability/logger.js';

/**
 * Resolve a Clerk id to our own user document.
 *
 * The `user.created` webhook is the normal path, but webhooks can be late or
 * lost — and a user who signs up and immediately opens a project would 500.
 * So this upserts on demand and treats the webhook as an optimisation.
 */
export async function resolveUser(clerkId: string): Promise<UserDoc> {
  const existing = await User.findOne({ clerkId });
  if (existing) return existing;

  const profile = await fetchClerkProfile(clerkId);
  logger.info({ clerkId }, 'creating user on demand (webhook not yet received)');

  // Upsert rather than create: two concurrent requests from a fresh sign-up
  // would otherwise race and one would fail the unique index.
  const user = await User.findOneAndUpdate(
    { clerkId },
    {
      $setOnInsert: {
        clerkId,
        email: profile.email,
        username: profile.username,
        avatarUrl: profile.avatarUrl,
        color: colorForClerkId(clerkId),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return user as UserDoc;
}

export async function touchLastSeen(userId: string): Promise<void> {
  await User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } });
}
