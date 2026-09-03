/* Does the model actually load and infer? Headless Chromium has no WebGPU, so
 * this exercises the WASM fallback path — slow, but it proves the pipeline,
 * the self-hosted runtime, and the frame plumbing all work. */
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

const errs = []; page.on('pageerror', e => errs.push(e.message));
const reqs = new Map();
page.on('response', r => { const u = r.url();
  if (/\.wasm|\.onnx|ort\//.test(u)) reqs.set(u.split('/').slice(-1)[0].slice(0,48), r.status()); });

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');
await page.click('.rail__btn[data-id="depth"]');
await page.waitForSelector('.depth__out', { timeout: 120_000 });
await page.waitForTimeout(600);

const read = () => page.$$eval('.readout', rs => Object.fromEntries(rs.map(r =>
  [r.querySelector('.ro-label').textContent.trim(),
   `${r.querySelector('.ro-value').textContent.trim()} | ${r.querySelector('.ro-note')?.textContent.trim() ?? ''}`])));
console.log('BEFORE LOAD:', JSON.stringify(await read(), null, 1));

await page.click('.btn:has-text("Load model")');
console.log('\nloading (this fetches ~25-50 MB and runs on CPU)…');

// Poll for either a running inference or an error.
let done = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(5000);
  const v = await read();
  const bad = await page.$$eval('.notice--bad', ns => ns.map(n=>n.textContent.replace(/\s+/g,' ').trim().slice(0,140)));
  const label = await page.locator('.dim.mono').first().textContent().catch(()=>'');
  const infer = v['Inference'] ?? '';
  process.stdout.write(`  t+${(i+1)*5}s  progress="${(label||'').trim().slice(0,40)}"  inference=${infer}\n`);
  if (bad.length) { console.log('\nERROR NOTICE:', bad[0]); done = true; break; }
  if (!infer.startsWith('—')) { done = true; break; }
}

if (done) {
  const v = await read();
  console.log('\nAFTER:');
  for (const [k, val] of Object.entries(v)) console.log(`  ${k.padEnd(14)} ${val}`);
  // Is the depth canvas actually painted?
  const painted = await page.evaluate(() => {
    const c = document.querySelector('.depth__out');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, Math.min(c.width,64), Math.min(c.height,64)).data;
    let nonzero = 0; for (let i=3;i<d.length;i+=4) if (d[i] > 0) nonzero++;
    return { w: c.width, h: c.height, opaquePixels: nonzero };
  });
  console.log('  depth canvas :', JSON.stringify(painted));
}
console.log('\nnetwork for runtime/model:');
for (const [u,s] of reqs) console.log(`  ${s}  ${u}`);
console.log(errs.length ? '\nERRORS: '+errs.join('; ').slice(0,300) : '\nno page errors');
await browser.close();
