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
/* The boot gate is the first interaction in every suite and it waits on a full
 * page load, fonts included. Playwright's 30 s default is not a budget for that
 * on a loaded machine — a full run was dropping a different suite each pass at
 * `waiting for locator('.engage')`, which read as flakiness and was really a
 * timeout that had never been stated. */
page.setDefaultTimeout(60_000);

const errs = []; page.on('pageerror', e => errs.push(e.message));
// Record every track handed out, to prove the probe releases it.
await page.addInitScript(() => { window.__tracks = [];
  const o = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async c => { const s = await o(c); window.__tracks.push(...s.getTracks()); return s; };
});
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="core"]');
await page.waitForTimeout(400);
await page.click('.btn:has-text("Probe camera capabilities")');
await page.waitForTimeout(2500);
const rows = await page.$$eval('.dtable tr', rs => rs.map(r => [...r.querySelectorAll('td')].map(c=>c.textContent.trim())));
console.log('CAMERA CAPABILITY ROWS:');
for (const r of rows) if (/exposureTime|^iso$|torch|capability keys/.test(r[0]??'')) console.log(`  ${r[0].padEnd(18)} ${r[1]}`);
const v = (await page.$$eval('.notice', ns=>ns.map(n=>n.textContent.replace(/\s+/g,' ').trim()))).find(t=>/exposure equation|12\.5/.test(t));
console.log('\nVERDICT:', v?.slice(0,180));
const states = await page.evaluate(() => window.__tracks.map(t=>t.readyState));
console.log('\ntracks after probing:', states.join(', '), '->', states.every(s=>s==='ended') ? 'PASS released' : 'FAIL leaked');
console.log(errs.length ? 'ERRORS: '+errs.join('; ') : 'no page errors');
await browser.close();
