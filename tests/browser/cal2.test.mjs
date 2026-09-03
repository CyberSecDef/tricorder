/* Two-point calibration through the real UI: synthesise a device whose true
 * FOV and height differ from the defaults, tap two known distances, and check
 * the instrument recovers both and then reads a THIRD distance correctly. */
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
/* The boot gate is the first interaction in every suite and it waits on a full
 * page load, fonts included. Playwright's 30 s default is not a budget for that
 * on a loaded machine — a full run was dropping a different suite each pass at
 * `waiting for locator('.engage')`, which read as flakiness and was really a
 * timeout that had never been stated. */
page.setDefaultTimeout(60_000);

const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="rangefinder"]');
await page.waitForSelector('.rf__video', { timeout: 8000 });

const tiltTo = (deg) => page.evaluate((deg) => {
  for (let i = 0; i < 220; i++) {
    const e = new Event('devicemotion');
    Object.assign(e, { acceleration:{x:0,y:0,z:0},
      accelerationIncludingGravity: { x: 0, y: -9.8*Math.cos(deg*Math.PI/180), z: -9.8*Math.sin(deg*Math.PI/180) },
      rotationRate:{alpha:0,beta:0,gamma:0}, interval: 16.67 });
    window.dispatchEvent(e);
  }
}, deg);

const box = await page.locator('.rf').boundingBox();
const frame = await page.evaluate(() => { const v = document.querySelector('.rf__video'); return {w:v.videoWidth,h:v.videoHeight}; });
// Inverse of tapToFrameCoords for object-fit: cover.
const tapAt = (u, v) => {
  const scale = Math.max(box.width/frame.w, box.height/frame.h);
  const offX = (box.width - frame.w*scale)/2, offY = (box.height - frame.h*scale)/2;
  const fx = (u+1)/2*frame.w, fy = (1-v)/2*frame.h;
  return page.mouse.click(box.x + fx*scale + offX, box.y + fy*scale + offY);
};
const setDist = async (d) => {
  const inp = page.locator('.rf__input').nth(1);
  await inp.fill(String(d)); await inp.dispatchEvent('change');
};
const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(), r.querySelector('.ro-value').textContent.trim()])));

// Ground truth we are pretending the hardware has.
const TRUE_H = 1.62, TRUE_FOV = 58.0;
const aspect = frame.h / frame.w;
// Distance an off-centre tap corresponds to, under the true optics.
const dist = (deg, u, v) => {
  const tanH = Math.tan(TRUE_FOV*Math.PI/360), tanV = tanH*aspect;
  const r = [u*tanH, v*tanV, -1];
  const n = Math.hypot(...r); const ray = r.map(x=>x/n);
  const g = [0, -Math.cos(deg*Math.PI/180), -Math.sin(deg*Math.PI/180)];
  const sin = ray[0]*g[0]+ray[1]*g[1]+ray[2]*g[2];
  return TRUE_H / Math.tan(Math.asin(sin));
};
console.log(`ground truth: height ${TRUE_H} m, FOV ${TRUE_FOV}°`);

// Two-point calibration at two genuinely different depression angles.
await page.click('.btn:has-text("Calibrate FOV + height")');
// Same tilt, very different frame positions: that is where the FOV
// information actually lives.
const A = {deg:28, u:0.06, v:-0.62}, B = {deg:28, u:-0.06, v:-0.12};
console.log(`  point A: ${dist(A.deg,A.u,A.v).toFixed(3)} m   point B: ${dist(B.deg,B.u,B.v).toFixed(3)} m`);
await setDist(dist(A.deg,A.u,A.v).toFixed(2));
await tiltTo(A.deg); await tapAt(A.u, A.v); await page.waitForTimeout(200);
console.log('after first tap, notices:', (await page.$$eval('.notice', ns=>ns.map(n=>n.textContent.slice(0,60).replace(/\s+/g,' ')))).filter(t=>/point|too close|Calibrat/i.test(t)));
await setDist(dist(B.deg,B.u,B.v).toFixed(2));
await tiltTo(B.deg); await tapAt(B.u, B.v); await page.waitForTimeout(150);

const notices = await page.$$eval('.notice', ns => ns.map(n=>n.textContent.replace(/\s+/g,' ').trim().slice(0,150)));
console.log('\nNOTICES AFTER CALIBRATION:');
for (const n of notices) console.log('  -', n);
const after = await read();
console.log(`\nrecovered height ${after['Camera height']} (want ${TRUE_H})`);
console.log(`recovered FOV    ${after['Field of view']}`);

// Now verify a THIRD, uncalibrated distance reads correctly.
const C = {deg:38, u:0.20, v:-0.15};
await tiltTo(C.deg); await tapAt(C.u, C.v); await page.waitForTimeout(150);
const check = await read();
const want = dist(C.deg, C.u, C.v);
const got = parseFloat(check['Horizontal distance']);
console.log(`\nthird, uncalibrated distance: got ${got} m, want ${want.toFixed(3)} m`);
console.log(`  error ${(Math.abs(got-want)/want*100).toFixed(2)}%  -> ${Math.abs(got-want)/want < 0.02 ? 'PASS' : 'FAIL'}`);
console.log(errs.length ? '\nERRORS: ' + errs.join('; ') : '\nno page errors');
await browser.close();
