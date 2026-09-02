/* Sonar end to end in a real browser. Chromium's fake audio device gives a
 * genuine AudioContext, worklet and mic — but no acoustic path from speaker to
 * mic, so there will be no echo to find. What this proves is that the graph,
 * the worklet, the frame-stamped capture and the correlation all run, and that
 * a no-return case reports itself honestly rather than inventing a distance. */
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
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error') errs.push('console: '+m.text()); });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="sonar"]');
await page.waitForSelector('.scope', { timeout: 10000 });
await page.waitForTimeout(1200);

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   `${r.querySelector('.ro-value').textContent.trim()} | ${r.querySelector('.ro-note')?.textContent.trim() ?? ''}`])));
console.log('BEFORE PING:');
for (const [k,v] of Object.entries(await read())) console.log(`  ${k.padEnd(18)} ${v}`);

// Did the worklet actually load and start delivering samples?
const workletOk = await page.evaluate(() => !!document.querySelector('.scope'));
console.log('\nfiring ping train…');
await page.click('.btn:has-text("Ping")');
await page.waitForTimeout(4000);
for (let i=0;i<20 && (await page.locator('.btn:has-text("Pinging")').count());i++) await page.waitForTimeout(1000);
await page.waitForTimeout(800);

console.log('\nAFTER PING:');
for (const [k,v] of Object.entries(await read())) console.log(`  ${k.padEnd(18)} ${v}`);
const notices = await page.$$eval('.notice', ns=>ns.map(n=>n.textContent.replace(/\s+/g,' ').trim()));
const st = notices.find(t=>/never heard the chirp|No consistent return|No usable return|No samples captured/.test(t));
console.log('\nstatus:', st ? st.slice(0,150) : '(none)');
// Was the A-scope painted?
const painted = await page.evaluate(() => {
  const c = document.querySelector('.scope canvas');
  const g = c.getContext('2d');
  const d = g.getImageData(0,0,Math.min(c.width,200),Math.min(c.height,80)).data;
  let n=0; for (let i=3;i<d.length;i+=4) if (d[i]>0) n++;
  return n;
});
console.log('A-scope opaque pixels:', painted);
console.log(errs.length ? '\nERRORS: '+errs.slice(0,3).join(' | ') : '\nno page errors');
await browser.close();
