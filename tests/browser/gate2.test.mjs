/* Walk Instrument 7 up the whole readiness ladder and confirm each rung
 * reports the right thing and, critically, that the index stays suppressed
 * until the compass is genuinely known-good. */
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
console.log('rail:', (await page.$$eval('.rail__btn', bs => bs.map(b => b.dataset.id))).join(', '));
await page.click('.rail__btn[data-id="magnetic"]');
await page.waitForTimeout(300);

// acc === null  -> webkitCompassAccuracy absent entirely
const feedOnce = (seconds, acc) => page.evaluate(({ seconds, acc }) => {
  const DT = 1/60;
  for (let i = 0; i < Math.round(seconds/DT); i++) {
    const t = (window.__t = (window.__t || 0) + DT);
    const me = new Event('devicemotion');
    Object.assign(me, { acceleration:{x:0,y:0,z:0},
      accelerationIncludingGravity:{x:0,y:0,z:-9.8},
      rotationRate:{alpha:0,beta:0,gamma:0}, interval: DT*1000 });
    window.dispatchEvent(me);
    const oe = new Event('deviceorientation');
    const props = { alpha:0, beta:0, gamma:0,
      webkitCompassHeading: 120 + (Math.sin(t*37)+Math.sin(t*91))*0.004 };
    if (acc !== null) props.webkitCompassAccuracy = acc;
    Object.assign(oe, props);
    window.dispatchEvent(oe);
  }
}, { seconds, acc });

const feed = async (seconds, acc) => {
  // Interleave so the staleness/rate measures see a realistic stream.
  const chunks = Math.max(1, Math.round(seconds / 0.25));
  for (let i = 0; i < chunks; i++) { await feedOnce(0.25, acc); await page.waitForTimeout(120); }
};

const state = async () => ({
  banner: (await page.$$eval('.notice--bad, .notice--ok, .notice', ns => ns.map(n=>n.textContent.replace(/\s+/g,' ').trim())))
            .find(t => /suppressed|Ready|Learning|No orientation data/.test(t))?.slice(0,72),
  index: await page.locator('.readout:has-text("Anomaly index") .ro-value').textContent(),
  note: await page.locator('.readout:has-text("Anomaly index") .ro-note').textContent(),
  acc: await page.locator('.readout:has-text("Compass accuracy") .ro-value').textContent(),
});

const show = async (label) => { const s = await state();
  console.log(`\n${label}`);
  console.log(`  index = ${s.index}   (${s.note})`);
  console.log(`  accuracy readout = ${s.acc}`);
  console.log(`  banner: ${s.banner}`); };

await page.waitForTimeout(2500);
await show('A. no events at all');

await feed(3, null);
await show('B. events firing, but webkitCompassAccuracy absent  <-- the bug');

await feed(3, -1);
await show('C. accuracy negative (iOS says invalid)');

await feed(3, 85);
await show('D. accuracy 85 (uncalibrated)');

await feed(8, 11);
await show('E. accuracy 11 (good) — should learn then report');

console.log(errs.length ? '\nERRORS: '+errs.join('; ') : '\nno page errors');
await browser.close();
