/* The raw-heading readouts must work independently of the residual chain, and
 * must state plainly whether iOS passed a disturbance through. */
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
await page.click('.rail__btn[data-id="magnetic"]');
await page.waitForTimeout(300);

const feedOnce = (seconds, headingSrc) => page.evaluate(({ seconds, headingSrc }) => {
  const fn = eval('(' + headingSrc + ')'); const DT = 1/60;
  for (let i = 0; i < Math.round(seconds/DT); i++) {
    const t = (window.__t = (window.__t || 0) + DT);
    const me = new Event('devicemotion');
    Object.assign(me, { acceleration:{x:0,y:0,z:0},
      accelerationIncludingGravity:{x:0,y:0,z:-9.8},
      rotationRate:{alpha:0,beta:0,gamma:0}, interval: DT*1000 });
    window.dispatchEvent(me);
    const oe = new Event('deviceorientation');
    Object.assign(oe, { alpha:0,beta:0,gamma:0,
      webkitCompassHeading: ((fn(t)%360)+360)%360, webkitCompassAccuracy: 11 });
    window.dispatchEvent(oe);
  }
}, { seconds, headingSrc: headingSrc.toString() });
const feed = async (sec, src) => { const n = Math.max(1, Math.round(sec/0.25));
  for (let i=0;i<n;i++){ await feedOnce(0.25, src); await page.waitForTimeout(110);} };

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   `${r.querySelector('.ro-value').textContent.trim()} | ${r.querySelector('.ro-note')?.textContent.trim() ?? ''}`])));

// Case 1: heading rock steady — exactly what the user is seeing.
await feed(6, (t) => 120);
let v = await read();
console.log('HEADING NEVER MOVES (the reported symptom):');
console.log('  Compass heading   :', v['Compass heading']);
console.log('  Heading deviation :', v['Heading deviation']);
console.log('  Peak deviation    :', v['Peak deviation']);
console.log('  Anomaly index     :', v['Anomaly index']);

// Case 2: heading genuinely disturbed.
const T = await page.evaluate(() => window.__t);
await feed(4, new Function('t', `const s=t-${T}; return 120 + 9*Math.min(1, s/1.2);`));
v = await read();
console.log('\nHEADING ACTUALLY MOVES 9 deg:');
console.log('  Compass heading   :', v['Compass heading']);
console.log('  Peak deviation    :', v['Peak deviation']);
console.log('  Anomaly index     :', v['Anomaly index'], ' <- transient may already have passed the 1.5 s window');
console.log('  Peak index        :', v['Peak index'], ' <- this is what must have caught it');
const evrows = await page.$$eval('.dtable tr', rs => rs.map(r => [...r.querySelectorAll('td')].map(c=>c.textContent.trim()).join('  ')));
console.log('  Event log         :', evrows.length ? evrows.join(' / ') : '(empty)');
console.log(errs.length ? '\nERRORS: '+errs.join('; ') : '\nno page errors');
await browser.close();
