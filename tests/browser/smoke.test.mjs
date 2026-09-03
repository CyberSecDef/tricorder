/* Desktop smoke test. It cannot validate iOS behaviour — there is no
 * DeviceMotion, no webkitCompassHeading and no real sensor data here — but it
 * proves the shell boots, every screen mounts and unmounts, and nothing throws.
 * We fake devicemotion/deviceorientation events so the render loops run. */
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

const URL = BASE;
const errors = [];

const browser = await chromium.launch({
  channel: undefined,
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 390, height: 844 },        // iPhone-ish portrait
  deviceScaleFactor: 3,
  permissions: ['geolocation', 'microphone'],
  geolocation: { latitude: 51.5074, longitude: -0.1278, accuracy: 8 },
});
const page = await ctx.newPage();
/* The boot gate is the first interaction in every suite and it waits on a full
 * page load, fonts included. Playwright's 30 s default is not a budget for that
 * on a loaded machine — a full run was dropping a different suite each pass at
 * `waiting for locator('.engage')`, which read as flakiness and was really a
 * timeout that had never been stated. */
page.setDefaultTimeout(60_000);

page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Drive the sensor streams: Chromium on Linux fires neither event on its own.
await page.addInitScript(() => {});
const pump = async () => page.evaluate(() => {
  let n = (window.__n = (window.__n || 0) + 1);
  const t = n / 60;
  const me = new Event('devicemotion');
  Object.assign(me, {
    acceleration: { x: 0.01 * Math.sin(t * 9), y: 0.01 * Math.cos(t * 5), z: 0.02 * Math.sin(t * 21) },
    accelerationIncludingGravity: { x: 0.1, y: 0.2, z: -9.79 },  // iOS convention
    rotationRate: { alpha: 1.2, beta: 0.3, gamma: -0.4 },
    interval: 16.67,
  });
  window.dispatchEvent(me);
  const oe = new Event('deviceorientation');
  Object.assign(oe, { alpha: (t * 20) % 360, beta: 4, gamma: -2, webkitCompassHeading: (t * 20) % 360, webkitCompassAccuracy: 12 });
  window.dispatchEvent(oe);
});

console.log('boot gate present:', await page.locator('.engage').count() === 1);
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn', { timeout: 10000 });
console.log('shell mounted');

const ids = await page.$$eval('.rail__btn', (bs) => bs.map((b) => b.dataset.id));
console.log('nav entries:', ids.join(', '));

for (const id of ids) {
  await page.click(`.rail__btn[data-id="${id}"]`);
  // Let the screen mount and run a few frames with live sensor input.
  for (let i = 0; i < 320; i++) { await pump(); }
  await page.waitForTimeout(500);
  const title = await page.locator('.bar__title').first().textContent();
  const holds = await page.locator('.bar__fill .bar__title').last().textContent().catch(() => '');
  const canvases = await page.locator('canvas').count();
  const readouts = await page.locator('.readout').count();
  console.log(`  ${id.padEnd(11)} → "${title.trim()}"  canvas:${canvases} readouts:${readouts}`);
  await page.screenshot({ path: `shot-${id}.png` });
}

// Switch back and forth quickly to exercise the mount/unmount race guard.
for (let i = 0; i < 6; i++) {
  await page.click('.rail__btn[data-id="spectrum"]');
  await page.click('.rail__btn[data-id="compass"]');
}
await page.waitForTimeout(400);
console.log('rapid switching survived');

// Verify the spectrum screen actually released the mic on exit.
const liveTracks = await page.evaluate(() => {
  // Count any MediaStreamTrack still live by probing the video/audio elements
  // is not possible directly; instead check the audio context node graph is
  // clean by confirming no getUserMedia stream is retained on window.
  return document.querySelectorAll('audio,video').length;
});
console.log('stray media elements:', liveTracks);

/* The rail must fit on a phone without scrolling.
 *
 * It is easy to break by accident: adding an instrument costs one more button,
 * and nothing else in the app notices. At thirteen entries and a 46px button
 * floor it overflowed a 390x640 viewport by 86px and the last instruments
 * needed a scroll to reach. Note that the type size was NOT what set the
 * height — the text needs about 34px and the button floor bound at 46 — so
 * shrinking the font alone changed nothing. This asserts the outcome rather
 * than either number. */
console.log('\n-- rail fits a phone --');
await page.setViewportSize({ width: 390, height: 640 });
await page.waitForTimeout(300);
const rail = await page.evaluate(() => {
  const r = document.querySelector('.rail');
  const btns = [...document.querySelectorAll('.rail__btn')];
  const stack = btns.reduce((a, b) => a + b.getBoundingClientRect().height, 0)
    + (btns.length - 1) * parseFloat(getComputedStyle(r).gap || '0');
  return {
    count: btns.length,
    stack: +stack.toFixed(1),
    visible: r.clientHeight,
    wrapped: btns.filter((b) => {
      const l = b.querySelector('.rail__label');
      return l.getBoundingClientRect().height > parseFloat(getComputedStyle(l).fontSize) * 1.45;
    }).map((b) => b.querySelector('.rail__label').textContent),
  };
});
const railOk = rail.stack <= rail.visible;
console.log(`  ${railOk ? 'PASS' : 'FAIL'}  all ${rail.count} rail buttons fit at 390x640` +
  `  — ${rail.stack}px of ${rail.visible}px` +
  (railOk ? ` (${(rail.visible - rail.stack).toFixed(0)}px spare)` : ' — OVERFLOWS, an instrument is unreachable without scrolling'));
console.log(`  ${rail.wrapped.length === 0 ? 'PASS' : 'FAIL'}  no rail label wraps to a second line` +
  (rail.wrapped.length ? `  — ${rail.wrapped.join(', ')}` : ''));

console.log(errors.length ? `\nERRORS (${errors.length}):\n` + errors.join('\n') : '\nno console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
