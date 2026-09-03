/* Analyze cannot be end-to-end tested on this machine: the CI-style Chromium
 * has no GPU, WebGPU falls back to SwiftShader, and one 80-token answer took
 * 658 SECONDS in the spike that proved the path works. So this suite asserts
 * the things that are true before inference — and the most important of them
 * is that a 200+ MB download never starts on its own. */
import { chromium } from 'playwright-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--enable-unsafe-webgpu'],
});
const ctx = await browser.newContext({
  ignoreHTTPSErrors: true, viewport: { width: 390, height: 900 }, permissions: ['camera'],
});
const page = await ctx.newPage();
page.setDefaultTimeout(60_000);

// Every request for model weights, so "did it download anything" is a fact
// rather than an inference from timing.
const weightReqs = [];
page.on('request', (r) => {
  const u = r.url();
  if (/\.onnx(_data)?(\?|$)/.test(u) || u.includes('huggingface.co')) weightReqs.push(u);
});
const errs = []; page.on('pageerror', (e) => errs.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.locator('.engage').click();
await page.waitForSelector('.rail__btn');

ok('analyze is in the rail',
   (await page.$$eval('.rail__btn', (b) => b.map((x) => x.dataset.id))).includes('analyze'));

await page.click('.rail__btn[data-id="analyze"]');
await page.waitForSelector('.analyze__view');
await page.waitForTimeout(1500);

console.log('\n-- the framing, which is the point --');
const firstNotice = (await page.locator('.stage__scroll .notice').first().textContent()) ?? '';
ok('opens by saying it does not measure anything',
   /does not measure anything/i.test(firstNotice));
ok('warns the output can be confidently wrong', /confidently wrong/i.test(firstNotice));
ok('states nothing leaves the device', /leaves the phone|on-device|runs here/i.test(firstNotice));
ok('the answer is NOT rendered as a readout', await page.evaluate(() => {
  // Before any inference there must be no answer element at all, and the two
  // readouts present are timing/length — never the answer itself.
  const labels = [...document.querySelectorAll('.readout .ro-label')].map((n) => n.textContent.trim().toLowerCase());
  return document.querySelector('.analyze__a') === null
    && labels.every((l) => !/answer$|what|describe/.test(l));
}), (await page.$$eval('.readout .ro-label', (n) => n.map((x) => x.textContent.trim()).join(', '))) || '(none)');

console.log('\n-- a 265 MB download must never be automatic --');
ok('no model weights requested on arrival', weightReqs.length === 0,
   weightReqs.slice(0, 2).join(' | '));
const loadBtn = page.locator('button', { hasText: /Load model/i }).first();
ok('an explicit Load button is offered', await loadBtn.count() === 1);
ok('the load button states the download size',
   /\d+\s*MB/i.test(await loadBtn.textContent() ?? ''), await loadBtn.textContent());
ok('analysis is disabled until the model is loaded',
   await page.locator('button', { hasText: /Load the model first/i }).count() === 1);

console.log('\n-- backend probe reports what is actually there --');
const modelNotice = (await page.locator('.stage__scroll .notice').nth(1).textContent()) ?? '';
ok('names the model', modelNotice.includes('SmolVLM-256M-Instruct'));
ok('names the backend', /webgpu|wasm/i.test(modelNotice));
const probe = await page.evaluate(async () => {
  const gpu = navigator.gpu; if (!gpu) return { device: 'wasm', f16: false };
  const a = await gpu.requestAdapter().catch(() => null);
  return a ? { device: 'webgpu', f16: a.features.has('shader-f16') } : { device: 'wasm', f16: false };
});
// shader-f16 is a per-adapter feature and NOT implied by WebGPU existing —
// asking for fp16 weights without it fails at session creation, after the
// download. The panel must reflect the adapter it actually found.
ok(`f16 reported honestly (adapter f16=${probe.f16})`,
   probe.f16 ? !/no <?code>?shader-f16|reports no/i.test(modelNotice)
             : /shader-f16/i.test(modelNotice) && /no/i.test(modelNotice),
   modelNotice.slice(0, 120));
ok('offered download size matches the dtype the adapter forces',
   (await loadBtn.textContent() ?? '').includes(probe.f16 ? '190' : '265'),
   await loadBtn.textContent());

console.log('\n-- questions --');
const qs = await page.$$eval('.btn--alt', (b) => b.map((x) => x.textContent.trim()));
ok('four questions offered', qs.length === 4, qs.join(' | '));
ok('one is selected by default',
   await page.locator('.btn--alt[aria-pressed="true"]').count() === 1);
await page.locator('.btn--alt').nth(2).click();
ok('selecting a different question moves the selection',
   await page.locator('.btn--alt').nth(2).getAttribute('aria-pressed') === 'true'
   && await page.locator('.btn--alt').nth(0).getAttribute('aria-pressed') === 'false');

console.log('\n-- lifecycle --');
await page.click('.rail__btn[data-id="core"]');
await page.waitForTimeout(600);
ok('camera released on leaving the screen',
   await page.evaluate(() => document.querySelectorAll('video').length === 0));
ok('still no weights downloaded after a visit', weightReqs.length === 0);

ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
