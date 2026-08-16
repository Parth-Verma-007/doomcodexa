import { signUp } from '../auth/accounts.js';
import { createSession } from '../auth/sessions.js';

/**
 * Test identities.
 *
 * Every suite used to assume a user into existence with a header, which worked
 * only because a dev bypass existed. Now that the API owns authentication there
 * is no such shortcut, and that is the point: the tests exercise the same
 * sign-up and session path a real person does.
 *
 * The collections are wiped after each test, so tokens are minted per test and
 * looked up by name — which keeps `as(OWNER)` at the call sites unchanged.
 */

const tokens = new Map<string, string>();

export const TEST_PASSWORD = 'correct-horse-battery';

/** Create the named accounts and remember a session token for each. */
export async function mintIdentities(names: readonly string[]): Promise<void> {
  tokens.clear();
  for (const name of names) {
    const user = await signUp({
      email: `${name}@codexa.test`,
      username: name,
      password: TEST_PASSWORD,
    });
    tokens.set(name, await createSession(user));
  }
}

export function tokenFor(name: string): string {
  const token = tokens.get(name);
  if (!token) throw new Error(`No test identity "${name}" — call mintIdentities() first.`);
  return token;
}

/** Request headers that authenticate as the named identity. */
export function authHeaders(name: string): Record<string, string> {
  return { Authorization: `Bearer ${tokenFor(name)}` };
}
