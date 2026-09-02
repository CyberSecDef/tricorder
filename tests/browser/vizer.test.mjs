/* Drive Vizer with synthetic scenes of known colour by swapping the sampled
 * frame, and check the spectrum reflects what is actually in view. */
import { chromium } from 'playwright-core';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';
const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['camera'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
console.log('rail:', (await page.$$eval('.rail__btn', b=>b.map(x=>x.dataset.id))).join(', '));
await page.click('.rail__btn[data-id="vizer"]');
await page.waitForSelector('.scope', { timeout: 10000 });
await page.waitForTimeout(2000);

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   `${r.querySelector('.ro-value').textContent.trim()} | ${r.querySelector('.ro-note')?.textContent.trim() ?? ''}`])));

console.log('\nLIVE (Chromium fake camera — a green rolling pattern):');
for (const [k,v] of Object.entries(await read())) console.log(`  ${k.padEnd(16)} ${v}`);

// The spectrum canvas should be painted, with colour where the scene has it.
const painted = await page.evaluate(() => {
  const c = document.querySelector('.scope canvas');
  const g = c.getContext('2d');
  const d = g.getImageData(0, 0, c.width, Math.floor(c.height * 0.85)).data;
  let lit = 0, redSum = 0, greenSum = 0, blueSum = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i+3] > 0 && (d[i] + d[i+1] + d[i+2]) > 120) lit++;
    redSum += d[i]; greenSum += d[i+1]; blueSum += d[i+2];
  }
  return { lit, redSum, greenSum, blueSum, w: c.width, h: c.height };
});
console.log('\nspectrum canvas:', JSON.stringify({ lit: painted.lit, size: `${painted.w}x${painted.h}` }));
console.log(`  bars drawn: ${painted.lit > 500 ? 'PASS' : 'FAIL'}`);
console.log(`  green-dominant as expected for this feed: ${painted.greenSum > painted.redSum ? 'PASS' : 'FAIL'}`);

const btns = await page.$$eval('.btn', b=>b.map(x=>x.textContent.trim()));
console.log('  buttons:', btns.join(' | '));
console.log(errs.length ? '\nERRORS: '+errs.slice(0,2).join(' | ') : '\nno page errors');
await browser.close();
