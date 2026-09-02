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
await page.waitForTimeout(600);
const btns = () => page.$$eval('.btn', bs => bs.map(b => b.textContent.trim()));
console.log('buttons:', (await btns()).join(' | '));
const infer = () => page.locator('.readout:has-text("Inference") .ro-note').textContent();
console.log('inference note (default):', await infer());
await page.click('.btn:has-text("Input:")');
await page.waitForTimeout(200);
console.log('after one input tap  :', await infer(), '|', (await btns()).find(t=>t.startsWith('Input')));
await page.click('.btn:has-text("Weights:")');
await page.waitForTimeout(200);
console.log('after one weights tap:', await infer(), '|', (await btns()).find(t=>t.startsWith('Weights')));
console.log('load button now      :', (await btns()).find(t=>/Load/.test(t)));
console.log(errs.length ? 'ERRORS: '+errs.join('; ') : 'no page errors');
await browser.close();
