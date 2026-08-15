/**
 * End-to-end execution check, against whatever engine the server picked.
 *
 * Written for the Docker-free path: it asserts that a language whose toolchain
 * is installed actually compiles and runs, that interactive stdin reaches the
 * program, and — just as important — that a language whose toolchain is
 * *missing* produces a sentence telling you what to install rather than a
 * generic failure.
 *
 *   node e2e/run.mjs [baseUrl] [language]
 */
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:5173';
const language = process.argv[3] ?? 'java';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const LABELS = { c: 'C', cpp: 'C++', java: 'Java', python: 'Python' };
// The radio's accessible name is "<label> <entrypoint>", e.g. "C++ main.cpp".
// Anchoring on the entrypoint keeps `main.c` from also matching `main.cpp`.
const ENTRYPOINTS = { c: 'main.c', cpp: 'main.cpp', java: 'Main.java', python: 'main.py' };

await page.goto(`${base}/dashboard?as=runner`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'New project' }).first().click();
await page.getByLabel('Name').fill(`Run ${language}`);
await page
  .getByRole('radio', { name: new RegExp(`${ENTRYPOINTS[language].replace('.', '\\.')}$`) })
  .check();
await page.getByRole('button', { name: 'Create' }).click();
await page.waitForURL(/\/p\//, { timeout: 30_000 });
await page.waitForSelector('.monaco-editor', { timeout: 60_000 });
await page.waitForTimeout(1500);

const terminal = () => page.locator('.xterm-screen').innerText();

await page.getByRole('button', { name: 'Run' }).first().click();

// Give the compiler a moment, then answer the prompt. The input is sent whether
// or not the prompt has appeared — a program blocked on stdin is still reading.
await page.waitForTimeout(3500);
await page.locator('.xterm-screen').click();
await page.keyboard.type('7 8');
await page.keyboard.press('Enter');

// Poll rather than sleep a fixed time: compilation speed varies wildly by
// toolchain (javac is slow to start, gcc is not).
let output = '';
for (let i = 0; i < 40; i += 1) {
  output = await terminal();
  if (/Sum = 15|exit \d|failed|No toolchain|cannot run/i.test(output)) break;
  await page.waitForTimeout(500);
}

console.log('\n--- terminal ---\n' + output.trim() + '\n----------------\n');

if (/cannot run|no toolchain|Install/i.test(output)) {
  // The toolchain is absent — then the only thing that matters is that the
  // message says so plainly and names the fix.
  check(
    `${LABELS[language]} is missing, and the message explains what to install`,
    /Install/i.test(output),
  );
} else {
  check(`${LABELS[language]} compiled and ran`, /Sum = 15/.test(output));
  check('Interactive stdin reached the program', /Sum = 15/.test(output));
  check('The run reported a clean exit', /exit 0|success/i.test(output));
}

await page.screenshot({ path: `e2e/screenshots/run-${language}.png` });
await browser.close();
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILED: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
