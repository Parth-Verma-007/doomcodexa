import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { signInSchema, signUpSchema } from '@codexa/shared';
import { asyncHandler, ApiError } from '../errors.js';
import { signIn, signUp } from '../../auth/accounts.js';
import { bearerToken } from '../../auth/context.js';
import { createSession, revokeSession } from '../../auth/sessions.js';
import { toUserDto } from '../../db/models/index.js';
import { logger } from '../../observability/logger.js';
import { config } from '../../config.js';

export const authRouter: Router = Router();

/**
 * Sign-up and sign-in.
 *
 * These are the only unauthenticated write routes in the API, and the only ones
 * where an attacker gets unlimited free guesses, so they carry their own limit
 * well below the global one. It is keyed by IP, which is a blunt instrument —
 * it will not stop a distributed attempt — but combined with a 64 MiB scrypt
 * per guess it makes online guessing thoroughly unattractive.
 */
const TOO_MANY = {
  error: { code: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' },
};

/**
 * Sign-in: only *failures* count.
 *
 * A person signing in correctly should never be told to come back later, and
 * the thing worth limiting is guessing.
 */
const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Relaxed outside production for the same reason as the global limiter: the
  // test suite and a local two-browser demo both sign in far more often than a
  // person does, and a 429 there looks like a broken app rather than a working
  // defence.
  limit: config.isProduction ? 20 : 5_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: TOO_MANY,
});

/**
 * Sign-up: *successes* count, which is the opposite of sign-in and the whole
 * point. Skipping them would leave account creation completely unbounded —
 * every request succeeds, so nothing would ever be counted — and on a server
 * that runs submitted code without a sandbox, an unlimited supply of accounts
 * is an unlimited supply of processes.
 */
const signUpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: config.isProduction ? 10 : 5_000,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'rate_limited',
      message: 'Too many accounts created from here. Try again later.',
    },
  },
});

authRouter.post(
  '/signup',
  signUpLimiter,
  asyncHandler(async (req, res) => {
    const input = signUpSchema.parse(req.body);
    const user = await signUp(input);
    const token = await createSession(user, req.get('user-agent') ?? undefined);

    logger.info({ userId: String(user._id) }, 'account created');
    res.status(201).json({ token, user: toUserDto(user), email: user.email });
  }),
);

authRouter.post(
  '/login',
  signInLimiter,
  asyncHandler(async (req, res) => {
    const input = signInSchema.parse(req.body);
    const user = await signIn(input);

    // One message for both "no such account" and "wrong password". Telling them
    // apart turns the form into an account-existence oracle.
    if (!user) throw ApiError.unauthorized('Incorrect email, username or password.');

    const token = await createSession(user, req.get('user-agent') ?? undefined);
    res.json({ token, user: toUserDto(user), email: user.email });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    // Deliberately unauthenticated and idempotent: signing out with a token
    // that has already expired should still succeed rather than 401.
    await revokeSession(bearerToken(req));
    res.status(204).end();
  }),
);
