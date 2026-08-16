/**
 * Build-time configuration.
 *
 * Down to one value since Codexa took over authentication: there is no
 * publishable key to supply and no development bypass to keep in step with the
 * API, so a fresh clone runs with no configuration at all.
 */

export const env = {
  apiUrl:
    (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ??
    'http://localhost:4000',

  isDev: import.meta.env.DEV,
};
