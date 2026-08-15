/**
 * Ad-hoc visual check. Not part of the test suite — run by hand when the
 * landing page or the theme tokens change, to look at it rather than assume it
 * renders.
 *
 *   node e2e/shot.mjs [baseUrl]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const base = process.argv[2] ?? 'http://localhost:4173';
const out = 'e2e/screenshots';
await mkdir(out, { recursive: true });

const browser = await chromium.launch();

/**
 * Seed the persisted store before any script runs, so the pre-paint snippet in
 * index.html picks the theme up on the first frame. Setting it afterwards would
 * exercise the React effect instead and hide a broken bootstrap.
 */
function seedTheme(page, theme) {
  return page.addInitScript((t) => {
    localStorage.setItem('codexa-ui', JSON.stringify({ state: { theme: t } }));
  }, theme);
}

async function shoot(name, { width, height, path = '/', theme = 'dark' }) {
  const page = await browser.newPage({ viewport: { width, height } });

  // Listeners must be attached BEFORE navigating, or the errors that blank the
  // page are the exact ones you miss.
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  await seedTheme(page, theme);
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  // Let the bloom animation settle so successive runs are comparable.
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png` });

  // What <html> actually resolved to — the assertion that the token blocks and
  // the pre-paint script agree on a name.
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.body).backgroundColor,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));

  console.log(
    `${name.padEnd(26)} ${width}x${height}  data-theme=${applied.theme}  bg=${applied.bg}` +
      (applied.overflow ? '  ⚠ HORIZONTAL OVERFLOW' : ''),
  );
  if (errors.length) console.log('  errors:', errors.slice(0, 3));
  await page.close();
  return errors.length === 0 && !applied.overflow;
}

/**
 * Note the tall viewports rather than `fullPage: true`. The app scrolls inside
 * a flex container (body is `overflow: hidden`, so the IDE owns its own
 * scrolling), which means the document never grows and a full-page capture
 * silently returns only the first screen.
 */
let ok = true;

for (const theme of ['light', 'dark']) {
  ok = (await shoot(`landing-${theme}`, { width: 1440, height: 1600, theme })) && ok;
  ok =
    (await shoot(`dashboard-${theme}`, { width: 1440, height: 900, path: '/dashboard', theme })) &&
    ok;
}

ok = (await shoot('landing-full', { width: 1440, height: 2600 })) && ok;
ok = (await shoot('landing-mobile', { width: 390, height: 844 })) && ok;

await browser.close();
console.log(`\nSaved to ${out}/ — ${ok ? 'no errors' : 'SEE WARNINGS ABOVE'}`);
