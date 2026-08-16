import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

/**
 * Password hashing.
 *
 * `scrypt` from `node:crypto` rather than argon2 or bcrypt, for one practical
 * reason: it needs no native module. Both alternatives compile at install time,
 * and this project has already been bitten once by a native dependency that
 * could not build on the developer's machine. scrypt is memory-hard, ships with
 * Node, and works unchanged on every host we might deploy to.
 *
 * The cost parameters are stored inside the hash, so raising them later only
 * affects new passwords — old ones keep verifying against the parameters they
 * were created with.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * N=2^16 with r=8 costs 64 MiB and roughly 150 ms per hash. That is deliberate:
 * it is the difference between an offline attacker trying billions of guesses a
 * second and trying a handful, and 150 ms is imperceptible on a login that
 * already crosses a network. Only the test environment lowers it.
 */
const PARAMS = { N: config.auth.passwordCostN, r: 8, p: 1 } as const;
const KEY_BYTES = 64;
const SALT_BYTES = 16;

/** Node refuses to run scrypt whose working set exceeds this, so state it. */
function maxmemFor(N: number, r: number): number {
  return 256 * N * r; // twice the 128*N*r the algorithm actually needs.
}

/** `scrypt$N$r$p$salt$hash`, both trailing fields base64url. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const { N, r, p } = PARAMS;
  const key = await scryptAsync(plain.normalize('NFKC'), salt, KEY_BYTES, {
    N,
    r,
    p,
    maxmem: maxmemFor(N, r),
  });
  return ['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/**
 * Constant-time verification.
 *
 * Every failure path returns plain `false` rather than throwing, so a malformed
 * or truncated stored hash cannot be told apart from a wrong password.
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise ask us to allocate an arbitrary amount of
  // memory on every login attempt.
  if (N < 1024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  const salt = Buffer.from(parts[4] as string, 'base64url');
  const expected = Buffer.from(parts[5] as string, 'base64url');
  // The stored length becomes scrypt's `keylen` below. Ours is always 64, but
  // an oversized value in the record would make every login attempt against
  // that account derive an arbitrary number of bytes — the same reason the
  // cost parameters are bounded above.
  if (salt.length === 0 || expected.length === 0 || expected.length > 1024) return false;

  try {
    const actual = await scryptAsync(plain.normalize('NFKC'), salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
    // Lengths are equal by construction, but timingSafeEqual throws if they are
    // not, and a throw here would leak the difference.
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A hash of a fixed dummy password, used to spend the same time on a login for
 * an account that does not exist as one that does. Without it, response time
 * tells an attacker which emails are registered.
 */
let dummyHash: string | null = null;

export async function equivalentWorkForMissingUser(plain: string): Promise<void> {
  dummyHash ??= await hashPassword('codexa-timing-equaliser');
  await verifyPassword(plain, dummyHash);
}
