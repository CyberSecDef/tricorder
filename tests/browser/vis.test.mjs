/* Does inference actually stop when the page is hidden? */
/* NETWORKIDLE NOTE: navigation waits for domcontentloaded, not networkidle.
 * Playwright discourages networkidle, and here it was actively harmful — the
 * page holds an HMR socket and several suites open camera or model requests,
 * so "500 ms of quiet" is not a state this app reliably reaches. Full runs kept
 * dropping a suite at `navigating to ... waiting until "networkidle"`. Every
 * suite already waits for `.engage` immediately afterwards, which is the real
 * readiness signal, so networkidle was pure fragility. */
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
/* Depth loads an ONNX model and compiles it for WebGPU. Every suite launches a
 * fresh browser profile, so that cost is paid again each time with a cold HTTP
 * cache — and Playwright's 30 s default action timeout is not a budget for it.
 * A run of the whole suite would drop a different depth-touching file roughly
 * once per pass, which looked like flakiness and was really this. Raise the
 * default rather than sprinkling timeouts on individual reads. */
page.setDefaultTimeout(120_000);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="depth"]');
await page.waitForSelector('.depth__out', { timeout: 120_000 });
await page.click('.btn:has-text("Load model")');

// Wait for inference to be running.
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  const v = await page.locator('.readout:has-text("Rate") .ro-value').textContent();
  if (v && !v.startsWith('—') && parseFloat(v) > 0) break;
}
const rate = () => page.locator('.readout:has-text("Rate") .ro-value').textContent();
console.log('visible, running   : rate =', await rate(), 'fps');

// Spoof hidden and fire the event.
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(4000);
console.log('hidden, after 4 s  : rate =', await rate(), 'fps   (should fall toward 0)');
await page.waitForTimeout(4000);
console.log('hidden, after 8 s  : rate =', await rate(), 'fps   <- inference paused if 0.0');

await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(6000);
console.log('visible again      : rate =', await rate(), 'fps   <- resumed if > 0');
await browser.close();
