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
await page.waitForTimeout(300);
console.log('SECTION ORDER:');
for (const s of await page.$$eval('.sect__label', ns => ns.map(n => n.textContent))) console.log('  -', s);
console.log('\nPROTOCOL SELECTION:');
for (const b of await page.$$eval('.btn-row .btn', ns => ns.map(n => `${n.textContent} current=${n.getAttribute('aria-current')}`))) console.log('  -', b);
const proc = await page.locator('.notice:has-text("Procedure")').textContent();
console.log('\nPROCEDURE SHOWN:\n  ' + proc.replace(/\s+/g,' ').trim());
await page.click('.btn:has-text("Sweep")');
await page.waitForTimeout(150);
const proc2 = await page.locator('.notice:has-text("Procedure")').textContent();
console.log('\nAFTER SWITCHING TO SWEEP:\n  ' + proc2.replace(/\s+/g,' ').trim());
console.log(errs.length ? '\nERRORS: ' + errs.join('; ') : '\nno page errors');
await browser.close();
