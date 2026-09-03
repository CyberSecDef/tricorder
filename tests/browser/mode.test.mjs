/* The whole point of the theme refactor was that a mode change reaches the
 * CANVASES, not just the chrome. Before it, ~98 colour literals were compiled
 * into the instruments and a palette switch left every trace, grid and axis
 * exactly as it was. So this suite does not check that the CSS changed — that
 * would have passed the whole time. It samples real pixels out of real
 * instrument canvases and requires them to move. */
import { chromium } from 'playwright-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['camera'],
});
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');

/* ---- the picker exists, on Core, at the top ---------------------------- */
await page.click('.rail__btn[data-id="core"]');
await page.waitForSelector('.modes');
const ids = await page.$$eval('.mode', (b) => b.map((x) => x.dataset.mode));
ok('eight modes offered', ids.length === 8, ids.join(', '));
ok('Standard is first', ids[0] === 'standard');
ok('Mode is the first section on Core', await page.evaluate(() => {
  const first = document.querySelector('.stage__scroll .sect__label');
  return first?.textContent.trim().toLowerCase() === 'mode';
}));

/* ---- switching actually re-tokenises the document ---------------------- */
const frameOf = () => page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--frame').trim());
const stdFrame = await frameOf();
await page.click('.mode[data-mode="red"]');
const redFrame = await frameOf();
ok('--frame changes with the mode', stdFrame !== redFrame, `${stdFrame} -> ${redFrame}`);
ok('red frame is the sampled Red Alert value', redFrame === '#ff2b2a', redFrame);
ok('data-mode lands on <html>',
   await page.evaluate(() => document.documentElement.dataset.mode) === 'red');

/* ---- state colours are NOT themed -------------------------------------- */
const stateIn = () => page.evaluate(() => {
  const s = getComputedStyle(document.documentElement);
  return ['--ok', '--warn', '--bad'].map((t) => s.getPropertyValue(t).trim()).join(',');
});
const redStates = await stateIn();
await page.click('.mode[data-mode="teal"]');
const tealStates = await stateIn();
ok('ok/warn/bad survive a mode change unchanged', redStates === tealStates, redStates);

/* ---- persistence ------------------------------------------------------- */
await page.click('.mode[data-mode="blue"]');
await page.reload({ waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
ok('mode survives a reload',
   await page.evaluate(() => document.documentElement.dataset.mode) === 'blue');

/* ---- THE ONE THAT MATTERS: canvases repaint --------------------------- */
/* A histogram of the canvas is compared rather than a single pixel: traces
 * move between frames, so a pixel-equality check would be flaky in both
 * directions. Hue content is stable frame to frame; the palette is not. */
const signature = async (sel) => page.evaluate((s) => {
  const c = document.querySelector(s);
  if (!c) return null;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const bins = new Array(12).fill(0);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2], a = d[i + 3];
    if (a < 32) continue;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 40 || mx - mn < 18) continue;         // ignore near-black and near-grey
    let h;
    if (mx === r) h = ((g - b) / (mx - mn) + 6) % 6;
    else if (mx === g) h = (b - r) / (mx - mn) + 2;
    else h = (r - g) / (mx - mn) + 4;
    bins[Math.floor(h * 2) % 12]++;
  }
  const tot = bins.reduce((x, y) => x + y, 0);
  return tot < 50 ? null : bins.map((v) => +(v / tot).toFixed(3));
}, sel);

const dist = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);

for (const [inst, sel] of [['compass', '.scope canvas'], ['seismo', '.scope canvas']]) {
  await page.click(`.rail__btn[data-id="${inst}"]`);
  await page.waitForSelector('.scope canvas', { timeout: 10000 });
  await page.waitForTimeout(900);

  await page.evaluate(() => document.documentElement.dataset.mode = 'standard');
  await page.click('.rail__btn[data-id="core"]');
  await page.click('.mode[data-mode="standard"]');
  await page.click(`.rail__btn[data-id="${inst}"]`);
  await page.waitForTimeout(900);
  const before = await signature(sel);

  await page.click('.rail__btn[data-id="core"]');
  await page.click('.mode[data-mode="teal"]');
  await page.click(`.rail__btn[data-id="${inst}"]`);
  await page.waitForTimeout(900);
  const after = await signature(sel);

  if (!before || !after) {
    ok(`${inst}: canvas had enough colour to compare`, false, 'too few lit pixels');
  } else {
    const d = dist(before, after);
    ok(`${inst}: canvas hue distribution moves with the mode`, d > 0.25, `L1 distance ${d.toFixed(3)}`);
  }
}

/* ---- and the carve-out: Vizer must NOT be themed ---------------------- */
/* Vizer's bars ARE the measurement — they are the hues present in the camera
 * feed. Theming them would recolour the answer, which is the one thing this
 * project does not do. The chrome around them is themed; the bars are not. */
await page.click('.rail__btn[data-id="vizer"]');
await page.waitForSelector('.scope canvas', { timeout: 10000 });
await page.waitForTimeout(2200);
const vizStd = await signature('.scope canvas');
await page.click('.rail__btn[data-id="core"]');
await page.click('.mode[data-mode="red"]');
await page.click('.rail__btn[data-id="vizer"]');
await page.waitForTimeout(2200);
const vizRed = await signature('.scope canvas');
if (!vizStd || !vizRed) {
  ok('vizer: spectrum had enough colour to compare', false, 'too few lit pixels');
} else {
  const d = dist(vizStd, vizRed);
  ok('vizer: spectrum is NOT recoloured by the mode', d < 0.25, `L1 distance ${d.toFixed(3)}`);
}

ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
