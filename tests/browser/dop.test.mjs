/* Instrument 8 end to end. Chromium's fake audio device gives us a real
 * AudioContext and a real (if synthetic) mic, so the graph, the emitter
 * lifecycle and the no-carrier detection can all be exercised. What it cannot
 * give us is an actual acoustic path from speaker to mic, so the carrier will
 * legitimately be absent — which is exactly the mute-switch case, and worth
 * confirming reports itself correctly. */
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
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
const page = await ctx.newPage();
/* The boot gate is the first interaction in every suite and it waits on a full
 * page load, fonts included. Playwright's 30 s default is not a budget for that
 * on a loaded machine — a full run was dropping a different suite each pass at
 * `waiting for locator('.engage')`, which read as flakiness and was really a
 * timeout that had never been stated. */
page.setDefaultTimeout(60_000);

const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
console.log('rail:', (await page.$$eval('.rail__btn', b=>b.map(x=>x.dataset.id))).join(', '));
await page.click('.rail__btn[data-id="doppler"]');
await page.waitForSelector('.readout', { timeout: 8000 });
await page.waitForTimeout(800);

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   `${r.querySelector('.ro-value').textContent.trim()} | ${r.querySelector('.ro-note')?.textContent.trim() ?? ''}`])));
const banner = async () => (await page.$$eval('.notice', ns=>ns.map(n=>n.textContent.replace(/\s+/g,' ').trim())))
  .find(t=>/Emitter is off|cannot hear the carrier|Learning the quiet|Running\./.test(t))?.slice(0,90);

console.log('\nBEFORE STARTING');
let v = await read();
console.log('  banner :', await banner());
console.log('  index  :', v['Motion index']);
console.log('  carrier:', v['Carrier']);

// Verify the emitter actually creates an oscillator on the real graph.
await page.click('.btn:has-text("Start emitting")');
await page.waitForTimeout(1500);
console.log('\nAFTER Start emitting');
v = await read();
console.log('  button :', await page.locator('.btn').first().textContent());
console.log('  banner :', await banner());
console.log('  index  :', v['Motion index']);
console.log('  carrier:', v['Carrier']);
console.log('  floor  :', v['Quiet floor']);

await page.click('.btn:has-text("Stop emitting")');
await page.waitForTimeout(400);
console.log('\nAFTER Stop emitting');
console.log('  button :', await page.locator('.btn').first().textContent());
console.log('  banner :', await banner());

// Leaving the screen must stop the tone and release the mic.
await page.evaluate(() => { window.__tracks = []; });
await page.click('.rail__btn[data-id="compass"]');
await page.waitForTimeout(500);
const media = await page.evaluate(() => document.querySelectorAll('audio,video').length);
console.log('\nAFTER LEAVING: stray media elements =', media);
console.log(errs.length ? '\nERRORS: '+errs.join('; ') : '\nno page errors');
await browser.close();
