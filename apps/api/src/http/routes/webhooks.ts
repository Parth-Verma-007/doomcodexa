import { Router, raw } from 'express';
import { Webhook } from 'svix';
import { config } from '../../config.js';
import { logger } from '../../observability/logger.js';
import { ApiError, asyncHandler } from '../errors.js';
import { User, colorForClerkId } from '../../db/models/index.js';

/**
 * Clerk user sync (§10).
 *
 * Mounted before `express.json()` because svix verifies a signature over the
 * exact raw bytes — parsing and re-serialising changes them and every request
 * would fail verification.
 */

export const webhookRouter: Router = Router();

interface ClerkUserEvent {
  type: string;
  data: {
    id: string;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
    email_addresses?: Array<{ id: string; email_address: string }>;
    primary_email_address_id?: string | null;
  };
}

webhookRouter.post(
  '/clerk',
  raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    if (!config.auth.webhookSecret) {
      throw ApiError.unavailable('Clerk webhooks are not configured.');
    }

    let event: ClerkUserEvent;
    try {
      const wh = new Webhook(config.auth.webhookSecret);
      event = wh.verify(req.body as Buffer, {
        'svix-id': String(req.headers['svix-id'] ?? ''),
        'svix-timestamp': String(req.headers['svix-timestamp'] ?? ''),
        'svix-signature': String(req.headers['svix-signature'] ?? ''),
      }) as ClerkUserEvent;
    } catch (err) {
      logger.warn({ err }, 'rejected a Clerk webhook with an invalid signature');
      // 400, not 500: this is a bad request, and Clerk should not retry it.
      throw ApiError.badRequest('Invalid webhook signature.');
    }

    switch (event.type) {
      case 'user.created':
      case 'user.updated':
        await upsertUser(event);
        break;
      case 'user.deleted':
        // Soft handling: the user's projects and messages still reference them,
        // so blank the identity rather than orphaning every document.
        await User.updateOne(
          { clerkId: event.data.id },
          { $set: { username: 'Deleted user', email: '', avatarUrl: null } },
        );
        break;
      default:
        logger.debug({ type: event.type }, 'ignoring Clerk webhook');
    }

    res.json({ received: true });
  }),
);

async function upsertUser(event: ClerkUserEvent): Promise<void> {
  const { data } = event;
  const primary =
    data.email_addresses?.find((e) => e.id === data.primary_email_address_id) ??
    data.email_addresses?.[0];
  const email = primary?.email_address ?? '';
  const username =
    data.username ||
    [data.first_name, data.last_name].filter(Boolean).join(' ') ||
    email.split('@')[0] ||
    'user';

  await User.updateOne(
    { clerkId: data.id },
    {
      $set: { email, username, avatarUrl: data.image_url ?? null },
      // The colour is assigned once and never changes, so a user's cursor
      // colour is stable for everyone who has collaborated with them.
      $setOnInsert: { clerkId: data.id, color: colorForClerkId(data.id) },
    },
    { upsert: true },
  );

  logger.info({ clerkId: data.id, type: event.type }, 'synced Clerk user');
}
