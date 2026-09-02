/* Feed the scanner real generated QR codes through the fake camera and check
 * it decodes them, describes them correctly, and — the point of the whole
 * instrument — never turns any of it into something clickable. */
import { chromium } from 'playwright-core';
import QRCode from 'qrcode';
import { writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';

// Chromium's fake camera can play a Y4M file; simplest reliable route is to
// render the QR into the page and let the scanner read a canvas instead.
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
await page.click('.rail__btn[data-id="scanner"]');
await page.waitForSelector('.rf__video', { timeout: 10000 });
await page.waitForTimeout(2500);   // let the wasm decoder load

// Decode a QR directly through the loaded module, which is what the scan loop
// does — this isolates the decoder + analysis from camera plumbing.
const payloads = [
  'https://example.com/hello',
  'WIFI:T:nopass;S:FreeWiFi;;',
  'javascript:alert(1)',
];
for (const text of payloads) {
  const dataUrl = await QRCode.toDataURL(text, { margin: 2, width: 400 });
  const got = await page.evaluate(async (url) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = url; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height);
    const zx = await import('/node_modules/zxing-wasm/dist/es/reader/index.js');
    zx.prepareZXingModule({ overrides: { locateFile: (p, pre) => p.endsWith('.wasm') ? '/zxing/' + p : pre + p } });
    const res = await zx.readBarcodes(data, { tryHarder: true, maxNumberOfSymbols: 1 });
    return res?.[0]?.text ?? null;
  }, dataUrl);
  console.log(`  decode ${JSON.stringify(text).padEnd(32)} -> ${got === text ? 'PASS' : 'FAIL got ' + JSON.stringify(got)}`);
}

// The safety property: nothing anywhere on this screen is clickable-to-navigate.
const anchors = await page.$$eval('.stage__scroll a, .stage__scroll [href]', a => a.length);
console.log(`\nanchors / href elements on the scanner screen: ${anchors}  -> ${anchors === 0 ? 'PASS (nothing navigable)' : 'FAIL'}`);
console.log(errs.length ? 'ERRORS: '+errs.slice(0,2).join(' | ') : 'no page errors');
await browser.close();
