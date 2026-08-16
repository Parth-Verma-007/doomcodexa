/**
 * Two-person collaboration check.
 *
 * This is the claim the whole product rests on, and it cannot be tested from
 * one page: convergence, remote cursors and presence only mean anything across
 * two independent browser contexts talking to the same server. Run it by hand
 * against a dev stack.
 *
 *   node e2e/collab.mjs [baseUrl]
 *
 * Each context signs up as its own account. A browser context is a separate
 * storage jar, so the two sessions never see each other — which is what makes
 * two "people" possible on one machine.
 */
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch();

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

/** Unique per run, so repeated runs do not collide on the unique username. */
const stamp = process.hrtime.bigint().toString(36).slice(-8);

async function openContext() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors };
}

/**
 * Register through the real form.
 *
 * Seeding a token into storage would be faster, but it would also stop this
 * from covering sign-up — and the sign-up path is now load-bearing for the
 * share-link flow, since anyone following a link needs an account first.
 */
async function signUp({ page }, handle) {
  const username = `${handle}${stamp}`;
  await page.goto(`${base}/sign-up`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(`${username}@codexa.test`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill('e2e-password-please');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  return username;
}

const alice = await openContext();
const bob = await openContext();

const aliceName = await signUp(alice, 'alice');
const bobName = await signUp(bob, 'bob');
check('Both people can register', Boolean(aliceName && bobName), `${aliceName}, ${bobName}`);

// ─── Alice creates a project ──────────────────────────────────────────────────

await alice.page.goto(`${base}/dashboard`, { waitUntil: 'networkidle' });
await alice.page.getByRole('button', { name: 'New project' }).first().click();
await alice.page.getByLabel('Name').fill('Pair session');
await alice.page.getByRole('button', { name: 'Create' }).click();
await alice.page.waitForURL(/\/p\//, { timeout: 30_000 });
await alice.page.waitForSelector('.monaco-editor', { timeout: 60_000 });

const projectId = alice.page.url().match(/\/p\/([a-f0-9]+)/)?.[1];
check('Alice can create a project and open the editor', Boolean(projectId), projectId);

// ─── Alice shares an editor link, Bob redeems it ──────────────────────────────

await alice.page.getByRole('button', { name: /Share/ }).click();
await alice.page.waitForTimeout(800);

// "Edit", not "View only" — Bob has to be able to type, or the whole point of
// the test evaporates.
await alice.page.getByRole('radio').first().check();
await alice.page.getByRole('button', { name: /Create a share link/ }).click();
await alice.page.waitForTimeout(1200);

const shareLink = await alice.page
  .getByLabel('Share link')
  .inputValue()
  .catch(() => null);
check(
  'Alice gets a share link',
  Boolean(shareLink && shareLink.includes('/join')),
  shareLink ?? '',
);

await alice.page.keyboard.press('Escape');

const joinUrl = new URL(shareLink);
await bob.page.goto(`${base}${joinUrl.pathname}${joinUrl.search}`, {
  waitUntil: 'networkidle',
});
await bob.page.waitForURL(/\/p\//, { timeout: 30_000 });
await bob.page.waitForSelector('.monaco-editor', { timeout: 60_000 });
check(
  'Bob joins through the link and reaches the same project',
  bob.page.url().includes(projectId),
);

// Both need the same file open before they can collide on it.
await alice.page.waitForTimeout(1500);
await bob.page.waitForTimeout(1500);

// ─── Presence ─────────────────────────────────────────────────────────────────

// Poll: presence arrives over a socket, so sampling it once is a coin toss even
// when the feature is working perfectly.
let aliceHeader = '';
for (let i = 0; i < 20; i += 1) {
  aliceHeader = await alice.page.locator('header').first().innerText();
  if (!/only you are here/i.test(aliceHeader)) break;
  await alice.page.waitForTimeout(500);
}
check(
  'Alice sees that she is no longer alone',
  !/only you are here/i.test(aliceHeader),
  aliceHeader.replace(/\n/g, ' | ').slice(0, 90),
);

// ─── Simultaneous editing ─────────────────────────────────────────────────────

/**
 * Read the visible document text out of the DOM.
 *
 * Monaco is bundled as a module and never lands on `window`, so there is no
 * editor API to ask. Reading `.view-line` is fine here because the fixture file
 * is short enough to render in full — on a long file Monaco virtualises and
 * this would only see the viewport.
 */
const readEditor = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.view-line')]
      // Monaco recycles line nodes and positions them with `top`, so DOM order
      // is not document order. Sorting by offset is what turns this back into
      // the file — without it two fully converged editors read as "diverged"
      // purely because their nodes were reused in a different sequence.
      .sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))
      // Monaco renders every space as a non-breaking space, not just the
      // indentation. Equality between two editors survives that, but
      // `includes('alice was here')` does not, because the haystack separates
      // those words with U+00A0. Normalising is what makes the substring
      // assertions mean what they appear to mean.
      .map((el) => el.textContent.split(String.fromCharCode(160)).join(' '))
      .join('\n'),
  );

/**
 * Put the caret on a line and type there, with real keystrokes.
 *
 * The click is forced because Monaco's overlay widgets sit above the text and
 * Playwright counts them as intercepting it, even though a person's click lands
 * fine. Everything after that is genuine keyboard input — which is the part
 * that has to be real for this test to mean anything.
 */
async function typeAt(page, line, text) {
  await page.locator('.monaco-editor .view-lines').first().click({ force: true });
  await page.keyboard.press('Control+Home');
  for (let i = 1; i < line; i += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.type(text, { delay: 12 });
}

// Deliberately at opposite ends of the file: a CRDT should merge both without
// either edit clobbering the other.
await Promise.all([
  typeAt(alice.page, 1, '// alice was here\n'),
  typeAt(bob.page, 6, '// bob was here\n'),
]);

await alice.page.waitForTimeout(2500);
await bob.page.waitForTimeout(500);

const aliceText = await readEditor(alice.page);
const bobText = await readEditor(bob.page);

check("Alice's edit reached Bob", bobText.includes('alice was here'));
check("Bob's edit reached Alice", aliceText.includes('bob was here'));
check(
  'Both sides converged on identical text',
  aliceText === bobText,
  aliceText === bobText ? `${aliceText.length} chars` : 'DIVERGED',
);
if (aliceText !== bobText || !aliceText.includes('bob was here')) {
  console.log('  alice:', JSON.stringify(aliceText));
  console.log('  bob:  ', JSON.stringify(bobText));
}

// ─── Remote cursor ────────────────────────────────────────────────────────────

// y-monaco names its decorations `yRemoteSelectionHead-<clientId>`; the app
// generates the colour and name rules for those classes at runtime.
const remoteCursors = await alice.page.locator('[class*="yRemoteSelectionHead-"]').count();
check('Alice sees Bob’s cursor in her editor', remoteCursors > 0, `${remoteCursors} cursor(s)`);

// ─── Persistence across a reload ──────────────────────────────────────────────

await bob.page.reload({ waitUntil: 'networkidle' });
await bob.page.waitForSelector('.monaco-editor', { timeout: 60_000 });
await bob.page.waitForTimeout(2500);
const afterReload = await readEditor(bob.page);
check(
  'The merged document survived a reload (server persisted it)',
  afterReload.includes('alice was here') && afterReload.includes('bob was here'),
);

await alice.page.screenshot({ path: 'e2e/screenshots/collab-alice.png' });
await bob.page.screenshot({ path: 'e2e/screenshots/collab-bob.png' });

for (const [who, ctx] of [
  ['alice', alice],
  ['bob', bob],
]) {
  if (ctx.errors.length) console.log(`  ${who} page errors:`, ctx.errors.slice(0, 3));
}

await browser.close();
console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.join(', ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
