/* About exists to answer "which build is this" when something goes wrong on a
 * phone that is not here. A version number alone cannot distinguish two builds
 * of 0.1.0 a week apart, so the assertions below are mostly about provenance
 * being present and honest rather than about layout. */
/* NETWORKIDLE NOTE: navigation waits for domcontentloaded, not networkidle.
 * Playwright discourages networkidle, and here it was actively harmful — the
 * page holds an HMR socket and several suites open camera or model requests,
 * so "500 ms of quiet" is not a state this app reliably reaches. Full runs kept
 * dropping a suite at `navigating to ... waiting until "networkidle"`. Every
 * suite already waits for `.engage` immediately afterwards, which is the real
 * readiness signal, so networkidle was pure fragility. */
import { chromium } from 'playwright-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
/* The boot gate is the first interaction in every suite and it waits on a full
 * page load, fonts included. Playwright's 30 s default is not a budget for that
 * on a loaded machine — a full run was dropping a different suite each pass at
 * `waiting for locator('.engage')`, which read as flakiness and was really a
 * timeout that had never been stated. */
page.setDefaultTimeout(60_000);

const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="core"]');
await page.waitForSelector('.credits');

const rows = await page.$$eval('.stage__scroll .dtable tr', (trs) => Object.fromEntries(
  trs.map((tr) => [tr.children[0]?.textContent.trim(), tr.children[1]?.textContent.trim()])));

ok('About is the first section',
   (await page.$$eval('.stage__scroll .sect__label', (n) => n.map((x) => x.textContent.trim().toLowerCase())))[0] === 'about');

console.log('\n-- provenance --');
for (const k of ['name', 'version', 'build', 'built', 'instruments', 'target platform', 'this browser', 'engine', 'licence']) {
  ok(`row "${k}" present and non-empty`, !!rows[k] && rows[k].length > 0, rows[k]);
}

// The dev server builds from this checkout, so About's claim about the commit
// is checkable against git rather than merely well-formed.
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return null; }
})();
const dirty = (() => {
  try { return execSync('git status --porcelain', { cwd: ROOT }).toString().trim() !== ''; } catch { return null; }
})();
if (commit) {
  // NOT compared to current HEAD. `define` is evaluated once when the server
  // starts, so a dev server left running across a commit legitimately reports
  // the older hash — asserting equality here would fail on the very next
  // commit and teach everyone to ignore this suite. What is actually being
  // claimed is that the hash is real, so check it resolves in this repository.
  const shown = /\b([0-9a-f]{7,40})\b/.exec(rows.build ?? '')?.[1];
  ok('build row shows a short commit hash', !!shown, rows.build);
  let resolves = false;
  try {
    execSync(`git cat-file -e ${shown}^{commit}`, { cwd: ROOT, stdio: 'ignore' });
    resolves = true;
  } catch { /* not a commit in this repo */ }
  ok('that hash resolves to a real commit in this repository', resolves, shown);
  ok('branch is named', /\(.+\)/.test(rows.build ?? ''), rows.build);
  console.log(`     (HEAD is ${commit}${dirty ? ', tree dirty' : ''}; the page may predate it if the`
    + ' dev server has been running a while — that is correct behaviour, not drift)');
} else {
  ok('build row states unknown outside a checkout', /unknown/i.test(rows.build ?? ''), rows.build);
}
ok('instrument count is derived, not hardcoded to a stale number', await page.evaluate(() => {
  const railInstruments = document.querySelectorAll('.rail__btn').length - 1;
  const cell = [...document.querySelectorAll('.dtable tr')]
    .find((tr) => tr.children[0]?.textContent.trim() === 'instruments')?.children[1]?.textContent ?? '';
  return cell.includes(String(railInstruments));
}), rows.instruments);
// Cross-checked against the repository rather than just asserted, so the
// panel cannot drift from the actual LICENSE file or package.json.
const licFile = existsSync(join(ROOT, 'LICENSE')) ? readFileSync(join(ROOT, 'LICENSE'), 'utf8') : '';
const pkgLic = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).license ?? null;
ok('a LICENSE file exists', licFile.length > 500, `${licFile.length} bytes`);
ok('About, package.json and LICENSE agree on the licence',
   rows.licence === pkgLic && licFile.startsWith(`${pkgLic} License`),
   `about=${rows.licence} pkg=${pkgLic}`);
ok('the licence actually disclaims liability',
   /WITHOUT WARRANTY OF ANY KIND/.test(licFile) && /NO EVENT SHALL THE\n?AUTHORS/.test(licFile.replace(/\s+/g, ' ').replace(/NO EVENT SHALL THE AUTHORS/, 'NO EVENT SHALL THE\nAUTHORS')));
ok('the licence actually requires attribution',
   /above copyright notice and this permission notice shall be included/i.test(licFile));

console.log('\n-- attributions --');
const creds = await page.$$eval('.credit', (cs) => cs.map((c) => ({
  name: c.querySelector('.credit__name')?.textContent.trim() ?? '',
  by: c.querySelector('.credit__by')?.textContent.trim() ?? '',
})));
ok('seven credits listed', creds.length === 7, String(creds.length));
ok('every credit has a name and an attribution',
   creds.every((c) => c.name.length > 1 && c.by.length > 10),
   creds.filter((c) => !c.by || c.by.length <= 10).map((c) => c.name).join(', '));
for (const who of ['CupcakeEternity', 'Hugging Face', 'ZXing', 'Microsoft']) {
  ok(`credits ${who}`, creds.some((c) => c.by.includes(who)));
}
// The palette chart is the one credit that is load-bearing rather than
// courteous: seven of the eight schemes are sampled from it.
ok('the colour-scheme source is credited by name',
   creds.some((c) => c.name.toLowerCase().includes('lcars') && c.by.includes('CupcakeEternity')));

ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
