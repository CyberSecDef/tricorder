/* End-to-end rangefinder check.
 * Tilts the synthetic gravity vector so the camera's centre ray is exactly 30°
 * below horizontal. At a 1.40 m camera height the centre tap must then read
 * h/tan(30°) = 2.4249 m — a number worked out by hand, not by the code.
 * Also confirms the camera track is actually stopped on screen exit. */
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
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

// Record every track handed out so we can assert it was stopped later.
await page.addInitScript(() => {
  window.__tracks = [];
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await orig(c);
    window.__tracks.push(...s.getTracks());
    return s;
  };
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');

// 30 deg depression: gDown = (0, -cos30, -sin30); iOS convention => accelG = 9.8 * gDown.
const pumpGravity = () => page.evaluate(() => {
  for (let i = 0; i < 200; i++) {
    const e = new Event('devicemotion');
    Object.assign(e, {
      acceleration: { x: 0, y: 0, z: 0 },
      accelerationIncludingGravity: { x: 0, y: -9.8 * Math.cos(Math.PI / 6), z: -9.8 * Math.sin(Math.PI / 6) },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      interval: 16.67,
    });
    window.dispatchEvent(e);
  }
});

await page.click('.rail__btn[data-id="rangefinder"]');
await page.waitForSelector('.rf__video', { timeout: 8000 });
await pumpGravity();
await page.waitForTimeout(300);

const frame = await page.evaluate(() => {
  const v = document.querySelector('.rf__video');
  return { w: v.videoWidth, h: v.videoHeight, ready: v.readyState };
});
console.log('video frame:', JSON.stringify(frame));

// Tap dead centre of the camera stage → u=0, v=0 → ray is the optical axis.
const box = await page.locator('.rf').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(250);

const vals = await page.$$eval('.readout', (rs) => Object.fromEntries(rs.map((r) =>
  [r.querySelector('.ro-label').textContent.trim(),
   r.querySelector('.ro-value').textContent.trim() + ' | ' + (r.querySelector('.ro-note')?.textContent.trim() ?? '')])));
console.log(JSON.stringify(vals, null, 2));

const dist = parseFloat(vals['Horizontal distance']);
const theta = parseFloat(vals['Depression']);
const EXPECT = 1.4 / Math.tan(Math.PI / 6);
console.log(`\ndepression: got ${theta}, want 30.0  → ${Math.abs(theta - 30) < 0.15 ? 'PASS' : 'FAIL'}`);
console.log(`distance:   got ${dist}, want ${EXPECT.toFixed(4)} → ${Math.abs(dist - EXPECT) < 0.02 ? 'PASS' : 'FAIL'}`);

// Leave the screen; the camera track must be stopped, not merely detached.
await page.click('.rail__btn[data-id="compass"]');
await page.waitForTimeout(400);
const states = await page.evaluate(() => window.__tracks.map((t) => `${t.kind}:${t.readyState}`));
console.log('\ntracks after leaving:', states.join(', '));
const leaked = states.filter((s) => s.endsWith('live'));
console.log(`leaked tracks: ${leaked.length} → ${leaked.length === 0 ? 'PASS' : 'FAIL'}`);

console.log(errs.length ? '\nERRORS: ' + errs.join('; ') : '\nno page errors');
await browser.close();
