/* Replays the shape of the real device run — a still phone with an 80 deg
 * heading excursion — through the static protocol, and checks the verdict
 * now accepts it instead of rejecting it for insufficient rotation. */
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

const feed = (seconds, headingSrc) => page.evaluate(({ seconds, headingSrc }) => {
  const fn = eval('(' + headingSrc + ')'); const DT = 1/60;
  for (let i = 0; i < Math.round(seconds/DT); i++) {
    const t = (window.__t = (window.__t || 0) + DT);
    const me = new Event('devicemotion');
    Object.assign(me, { acceleration:{x:0,y:0,z:0},
      accelerationIncludingGravity:{x:0,y:0,z:-9.8},
      rotationRate:{alpha:0,beta:0,gamma:0}, interval: DT*1000 });  // phone still
    window.dispatchEvent(me);
    const oe = new Event('deviceorientation');
    Object.assign(oe, { alpha:0,beta:0,gamma:0,
      webkitCompassHeading: ((fn(t)%360)+360)%360, webkitCompassAccuracy: 10 });
    window.dispatchEvent(oe);
  }
}, { seconds, headingSrc: headingSrc.toString() });

await feed(3, (t) => 120);                       // settle, compass steady
await page.waitForTimeout(120);
console.log('protocol default:', await page.locator('.btn[aria-current="true"]').first().textContent());

// Baseline: still, quiet compass.
await page.click('.btn:has-text("Record baseline")');
await feed(6, (t) => 120);
await page.click('.btn:has-text("Stop")');
await page.waitForTimeout(120);

// Disturbed: still, but the heading ramps 80 deg and returns — the real shape.
const T0 = await page.evaluate(() => window.__t);
await page.click('.btn:has-text("Record disturbed")');
await feed(6, new Function('t', `
  const s = t - ${T0};
  if (s < 1.5) return 120;
  if (s < 3.0) return 120 + 80 * (s - 1.5) / 1.5;
  if (s < 4.0) return 200;
  return 200 - 80 * Math.min(1, (s - 4.0) / 1.5);
`));
await page.click('.btn:has-text("Stop")');
await page.waitForTimeout(250);

const rows = await page.$$eval('.dtable tr', rs => rs.map(r => [...r.querySelectorAll('td')].map(c => c.textContent.trim())));
console.log('\nRUNS');
for (const r of rows) console.log('  ' + r.map((c,i) => i ? c.padStart(12) : c.padEnd(20)).join(''));
const notices = await page.$$eval('.notice', ns => ns.map(n => n.textContent.replace(/\s+/g,' ').trim()));
console.log('\nVERDICT:\n  ' + notices[notices.length-1].slice(0, 420));
console.log(errs.length ? '\nERRORS: ' + errs.join('; ') : '\nno page errors');
await browser.close();
