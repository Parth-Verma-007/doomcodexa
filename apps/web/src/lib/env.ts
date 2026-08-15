/**
 * Build-time configuration. Read once and validated loudly, so a missing
 * publishable key is a clear boot error rather than a blank page.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is not set. Copy .env.example to apps/web/.env.local and fill it in.`);
  }
  return value;
}

/**
 * Mirrors the API's `AUTH_DEV_BYPASS`. Without a matching switch here the app
 * still mounts Clerk and shows a blank page, so running the project locally
 * would require a Clerk account even though the API does not.
 *
 * Development only — `vite build` refuses to produce a bundle with it on.
 */
const devBypass = import.meta.env.VITE_AUTH_DEV_BYPASS === '1';

if (devBypass && import.meta.env.PROD) {
  throw new Error(
    'VITE_AUTH_DEV_BYPASS must never be set in a production build — it disables authentication.',
  );
}

/**
 * Resolve the bypass identity, and make it survive a reload.
 *
 * `?as=alice` is only ever on the first URL you type. Navigating to a project
 * drops it, so a refresh would silently fall back to the default identity — and
 * the server would then 404 the project, because that other user is not a
 * member. It reads exactly like "collaboration is broken" when nothing is.
 *
 * Stored in `sessionStorage`, not `localStorage`, and that is the whole point:
 * session storage is per-tab, so two tabs in one browser can hold two different
 * identities and each keeps its own across reloads. That is what makes a
 * two-person demo possible on one machine.
 */
function resolveDevUser(): string {
  const configured = import.meta.env.VITE_DEV_USER as string | undefined;
  if (configured) return configured;

  const KEY = 'codexa-dev-user';
  const requested = new URLSearchParams(window.location.search).get('as');

  try {
    if (requested) {
      sessionStorage.setItem(KEY, requested);
      return requested;
    }
    return sessionStorage.getItem(KEY) ?? 'user_dev_bypass';
  } catch {
    // Storage blocked; fall back to the URL for this page load only.
    return requested ?? 'user_dev_bypass';
  }
}

export const env = {
  apiUrl:
    (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ??
    'http://localhost:4000',

  devBypass,

  /**
   * The identity assumed while bypassing Clerk. Add `?as=alice` to any URL and
   * that tab becomes Alice until it is closed, so one machine can act as two
   * collaborators — which is how you demo real-time editing without two Clerk
   * accounts.
   */
  devUser: devBypass ? resolveDevUser() : 'user_dev_bypass',

  // Only required when Clerk is actually in use.
  clerkPublishableKey: devBypass
    ? ''
    : required(
        'VITE_CLERK_PUBLISHABLE_KEY',
        import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
      ),

  isDev: import.meta.env.DEV,
};
