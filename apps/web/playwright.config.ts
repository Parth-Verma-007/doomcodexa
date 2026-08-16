import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (§14).
 *
 * The collaboration checks need two signed-in identities, and since Codexa owns
 * authentication they simply register two accounts through the sign-up form
 * against the local database — one browser context each, because a context is
 * its own storage jar. Nothing to configure: no test credentials, no secrets, so
 * a fresh clone gets the same run CI does.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
