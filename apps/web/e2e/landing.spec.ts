import { expect, test } from '@playwright/test';

/**
 * Smoke tests that need no credentials. These catch the failures that actually
 * happen in practice: a bad env var taking the whole app down, or the Monaco
 * chunk creeping back onto the landing page's critical path (§13).
 */

test('the landing page renders and offers a way in', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Code together');
  await expect(page.getByRole('link', { name: /sign in|dashboard/i }).first()).toBeVisible();

  for (const language of ['C', 'C++', 'Java', 'Python']) {
    await expect(page.getByText(language, { exact: true })).toBeVisible();
  }
});

test('the landing page does not download the editor bundle', async ({ page }) => {
  // The IDE chunk is several megabytes. A visitor who never opens a project
  // must not pay for it — this asserts the lazy route boundary holds.
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const editorAssets = requested.filter((url) => /ProjectPage|monaco|xterm/i.test(url));
  expect(editorAssets, `unexpected editor assets: ${editorAssets.join(', ')}`).toHaveLength(0);
});

test('an unauthenticated visitor is sent to sign-in, keeping their destination', async ({
  page,
}) => {
  await page.goto('/p/000000000000000000000000');
  await page.waitForURL(/sign-in/);
  // The share-link flow depends on this: signing in must return you to the
  // project you were invited to, not to a generic dashboard.
  expect(page.url()).toContain('redirect_url');
});
