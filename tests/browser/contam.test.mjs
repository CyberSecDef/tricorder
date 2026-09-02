/* Reproduces the contamination: drive a large excursion, then immediately
 * record a genuinely quiet baseline. Before the fix the baseline reported a
 * ~14 deg noise floor it did not have. It must now report ~0. */
import { chromium } from 'playwright-core';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';
const browser = await chromium.launch({
  executablePath: CHROME,
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="magprobe"]');
await page.waitForTimeout(200);

const feed = (seconds, src) => page.evaluate(({ seconds, src }) => {
  const fn = eval('(' + src + ')'); const DT = 1/60;
  for (let i = 0; i < Math.round(seconds/DT); i++) {
    const t = (window.__t = (window.__t || 0) + DT);
    const me = new Event('devicemotion');
    Object.assign(me, { acceleration:{x:0,y:0,z:0},
      accelerationIncludingGravity:{x:0,y:0,z:-9.8},
      rotationRate:{alpha:0,beta:0,gamma:0}, interval: DT*1000 });
    window.dispatchEvent(me);
    const oe = new Event('deviceorientation');
    Object.assign(oe, { alpha:0,beta:0,gamma:0,
      webkitCompassHeading: ((fn(t)%360)+360)%360, webkitCompassAccuracy: 19.7 });
    window.dispatchEvent(oe);
  }
}, { seconds, src: src.toString() });

// Contaminate: an 80 deg excursion, exactly like the previous session.
await feed(2, (t) => 120);
const A = await page.evaluate(() => window.__t);
await feed(2, new Function('t', `const s=t-${A}; return 120 + 80*Math.min(1,s/1.5);`));
await feed(1, (t) => 200);
console.log('contaminated the detrend EMA with an 80 deg excursion');

// Now record a genuinely dead-quiet baseline immediately afterwards.
await page.click('.btn:has-text("Record baseline")');
await feed(7, (t) => 200);
await page.click('.btn:has-text("Stop")');
await page.waitForTimeout(200);

const rows = await page.$$eval('.dtable tr', rs => rs.map(r => [...r.querySelectorAll('td')].map(c => c.textContent.trim())));
for (const r of rows) if (r.length) console.log('  ' + r.map((c,i)=> i? c.padStart(12):c.padEnd(20)).join(''));
const rms = parseFloat(rows.find(r => r[0]?.startsWith('residual RMS'))?.[1] ?? 'NaN');
console.log(`\nbaseline RMS = ${rms} deg -> ${rms < 0.5 ? 'PASS (was 13.98 before the fix)' : 'FAIL, still contaminated'}`);
console.log(errs.length ? 'ERRORS: ' + errs.join('; ') : 'no page errors');
await browser.close();
