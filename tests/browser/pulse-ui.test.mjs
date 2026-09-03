/* Chromium's fake camera shows a moving pattern, not a fingertip, so the
 * finger check must REJECT it — that is the property worth testing here. */
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
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
console.log('rail:', (await page.$$eval('.rail__btn', b=>b.map(x=>x.dataset.id))).join(', '));
await page.click('.rail__btn[data-id="pulse"]');
await page.waitForSelector('.scope', { timeout: 10000 });
await page.waitForTimeout(800);

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   `${r.querySelector('.ro-value').textContent.trim()} | ${r.querySelector('.ro-note')?.textContent.trim() ?? ''}`])));
const banner = async () => (await page.$$eval('.notice', n=>n.map(x=>x.textContent.replace(/\s+/g,' ').trim())))
  .find(t=>/Not running|No finger|Collecting|medical device/.test(t) && !/not a medical/.test(t));

console.log('\nBEFORE START');
console.log('  ', JSON.stringify(await read()['Pulse'] ?? (await read())['Pulse']));
console.log('   banner:', (await banner())?.slice(0,70));

await page.click('.btn:has-text("Start")');
await page.waitForTimeout(4000);
console.log('\nAFTER START (fake camera, not a finger)');
for (const [k,v] of Object.entries(await read())) console.log(`  ${k.padEnd(12)} ${v}`);
console.log('   banner:', (await banner())?.slice(0,90));

const bpm = (await read())['Pulse'];
console.log(`\n  refuses to invent a rate: ${bpm.startsWith('—') ? 'PASS' : 'FAIL — reported ' + bpm}`);
const btn = await page.locator('.btn').first().textContent();
console.log(`  start button toggled: ${btn.trim() === 'Stop' ? 'PASS' : 'FAIL'}`);
console.log(errs.length ? 'ERRORS: '+errs.slice(0,2).join(' | ') : 'no page errors');
await browser.close();
