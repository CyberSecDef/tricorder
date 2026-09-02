/* Does the probe respond to a STATIONARY disturbance?
 * Phone perfectly still (zero gyro), then the compass heading steps by 15 deg
 * as if a magnet were placed beside it. Predicted yaw is zero, so the whole
 * step must land in the residual. If it does not, the harness is broken and
 * the user's "no impact" observation says nothing about Core Motion. */
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
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="magprobe"]');
await page.waitForTimeout(200);

const feed = (seconds, headingFn) => page.evaluate(({ seconds, fnSrc }) => {
  const headingFn = eval(fnSrc);
  const DT = 1 / 60;
  const N = Math.round(seconds / DT);
  for (let i = 0; i < N; i++) {
    const t = (window.__t = (window.__t || 0) + DT);
    const me = new Event('devicemotion');
    Object.assign(me, {
      acceleration: { x: 0, y: 0, z: 0 },
      accelerationIncludingGravity: { x: 0, y: 0, z: -9.8 },   // flat, perfectly still
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },           // ZERO rotation
      interval: DT * 1000,
    });
    window.dispatchEvent(me);
    const oe = new Event('deviceorientation');
    Object.assign(oe, { alpha: 0, beta: 0, gamma: 0,
      webkitCompassHeading: headingFn(t), webkitCompassAccuracy: 10 });
    window.dispatchEvent(oe);
  }
}, { seconds, fnSrc: headingFn.toString() });

const read = () => page.$$eval('.readout', (rs) => Object.fromEntries(rs.map((r) =>
  [r.querySelector('.ro-label').textContent.trim(), r.querySelector('.ro-value').textContent.trim()])));

// Settle on a rock-steady heading of 90 deg, then mark the reference.
await feed(8, (t) => 90);
await page.click('.btn:has-text("Mark reference")');
await page.waitForTimeout(100);
console.log('steady, no disturbance: ', JSON.stringify(await read()));

// Magnet placed: heading swings 15 deg over ~0.4 s, then holds.
await feed(0.5, (t) => 90 + 15 * Math.min(1, (t - 8) / 0.4));
await page.waitForTimeout(100);
console.log('during a 15 deg step:   ', JSON.stringify(await read()));

await feed(1.0, (t) => 105);
await page.waitForTimeout(100);
console.log('1 s after the step:     ', JSON.stringify(await read()));

await browser.close();
