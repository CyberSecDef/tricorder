/* Instrument 7 end to end, driven with the shape of the real device data:
 * a quiet phone, then a heading excursion with no rotation to justify it. */
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

const feed = (seconds, headingSrc, acc) => page.evaluate(({ seconds, headingSrc, acc }) => {
  const fn = eval('(' + headingSrc + ')'); const DT = 1/60;
  for (let i = 0; i < Math.round(seconds/DT); i++) {
    const t = (window.__t = (window.__t || 0) + DT);
    const me = new Event('devicemotion');
    Object.assign(me, { acceleration:{x:0,y:0,z:0},
      accelerationIncludingGravity:{x:0,y:0,z:-9.8},
      rotationRate:{alpha:0,beta:0,gamma:0}, interval: DT*1000 });
    window.dispatchEvent(me);
    const oe = new Event('deviceorientation');
    // A touch of realistic jitter so the learned floor is not exactly zero.
    const jitter = (Math.sin(t*37.1)+Math.sin(t*91.7))*0.004;
    Object.assign(oe, { alpha:0,beta:0,gamma:0,
      webkitCompassHeading: ((fn(t)+jitter)%360+360)%360, webkitCompassAccuracy: acc });
    window.dispatchEvent(oe);
  }
}, { seconds, headingSrc: headingSrc.toString(), acc });

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   r.querySelector('.ro-value').textContent.trim() + ' | ' + (r.querySelector('.ro-note')?.textContent.trim() ?? '')])));
const stateNotice = async () => (await page.$$eval('.notice', ns => ns.map(n => n.textContent.replace(/\s+/g,' ').trim())))
  .find(t => /Ready|Learning|not calibrated|No orientation/.test(t))?.slice(0,90);

// --- gate: uncalibrated compass must suppress the index -------------------
await page.click('.rail__btn[data-id="magnetic"]');
await page.waitForTimeout(200);
await feed(4, (t) => 120, 85);
await page.waitForTimeout(150);
console.log('uncalibrated:', JSON.stringify((await read())['Anomaly index']));
console.log('  state:', await stateNotice());

// --- learn the floor on a good compass ------------------------------------
await page.click('.btn:has-text("Re-learn noise floor")');
await feed(5, (t) => 120, 11);
await page.waitForTimeout(150);
const learned = await read();
console.log('\nafter learning:', JSON.stringify(learned['Noise floor']));
console.log('  index:', learned['Anomaly index']);
console.log('  state:', await stateNotice());

// --- quiet: index should sit near 1x --------------------------------------
await feed(3, (t) => 120, 11);
await page.waitForTimeout(150);
console.log('\nquiet index:', (await read())['Anomaly index']);

// --- anomaly: heading moves 12 deg with zero rotation ---------------------
const T0 = await page.evaluate(() => window.__t);
await feed(2.5, new Function('t', `const s=t-${T0}; return 120 + 12*Math.min(1, s/1.0);`), 11);
await page.waitForTimeout(150);
const during = await read();
console.log('\nDURING ANOMALY');
console.log('  index:    ', during['Anomaly index']);
console.log('  residual: ', during['Residual']);
console.log('  peak:     ', during['Peak index']);

// --- back to quiet, event should be logged --------------------------------
await feed(4, (t) => 132, 11);
await page.waitForTimeout(300);
console.log('\nafter it passes, index:', (await read())['Anomaly index']);
const rows = await page.$$eval('.dtable tr', rs => rs.map(r => [...r.querySelectorAll('td')].map(c => c.textContent.trim())));
console.log('EVENT LOG:');
for (const r of rows) if (r.length) console.log('  ' + r.join('  '));

console.log(errs.length ? '\nERRORS: ' + errs.join('; ') : '\nno page errors');
await browser.close();
