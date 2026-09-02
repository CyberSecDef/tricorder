/* Does the resolution lever now actually change inference cost? Measures the
 * same model at two processor sizes on the WASM path. */
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
await page.click('.rail__btn[data-id="depth"]');
await page.waitForSelector('.depth__out', { timeout: 10000 });
await page.waitForTimeout(500);
console.log('default size button:', (await page.$$eval('.btn', b=>b.map(x=>x.textContent.trim()))).find(t=>t.startsWith('Input')));

await page.click('.btn:has-text("Load model")');
const note = () => page.locator('.readout:has-text("Inference") .ro-note').textContent();
const val  = () => page.locator('.readout:has-text("Inference") .ro-value').textContent();

const settle = async (label) => {
  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(4000);
    const v = await val();
    if (!v.startsWith('—')) {
      // let a couple more frames go by so the reading is representative
      await page.waitForTimeout(12000);
      console.log(`  ${label.padEnd(16)} ${await val()} ms   (${(await note()).trim()})`);
      return;
    }
    const bad = await page.$$eval('.notice--bad', ns=>ns.map(n=>n.textContent.slice(0,100)));
    if (bad.length) { console.log('  ERROR:', bad[0]); return; }
  }
  console.log(`  ${label}: timed out`);
};
console.log('\nmeasuring (WASM path, so slow in absolute terms — the RATIO is the point):');
await settle('252px');

// Cycle 252 -> 350 -> 518, then measure native for the contrast.
await page.click('.btn:has-text("Input:")');
await page.click('.btn:has-text("Input:")');
await page.waitForTimeout(300);
console.log('  switched to:', (await page.$$eval('.btn', b=>b.map(x=>x.textContent.trim()))).find(t=>t.startsWith('Input')));
await page.waitForTimeout(30000);
console.log(`  ${'518px (native)'.padEnd(16)} ${await val()} ms   (${(await note()).trim()})`);

console.log(errs.length ? '\nERRORS: '+errs.join('; ') : '\nno page errors');
await browser.close();
