/* The Analyze crash-on-capture regression, isolated.
 *
 * A phone was killing the tab the moment it captured a frame. The cause was
 * not model size: Idefics3's processor ships `size.longest_edge: 2048` and
 * `do_image_splitting: true`, so ONE photograph became thirteen 512px
 * sub-images — a 41 MB input tensor and ~880 prompt tokens before a single
 * activation. This suite pins the clamp that fixes it.
 *
 * It loads the PROCESSOR only (a few small JSON files), never the weights, so
 * it runs in seconds and can live in the normal suite — unlike inference,
 * which takes eleven minutes on a GPU-less CI box. */
import { chromium } from 'playwright-core';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = process.env.CHROME_PATH
  ?? join(process.env.HOME ?? '', '.cache/ms-playwright/chromium-1234/chrome-linux64/chrome');
const BASE = process.env.TRICORDER_URL ?? 'https://localhost:5173/';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const browser = await chromium.launch({ executablePath: CHROME });
const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
page.setDefaultTimeout(120_000);
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });

const r = await page.evaluate(async () => {
  const { AutoProcessor, RawImage } = await import('/node_modules/.vite/deps/@huggingface_transformers.js');
  const proc = await AutoProcessor.from_pretrained('HuggingFaceTB/SmolVLM-256M-Instruct');

  const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480;
  const g = cv.getContext('2d');
  g.fillStyle = '#2d7a2d'; g.fillRect(0, 0, 640, 480);
  g.fillStyle = '#cc2222'; g.beginPath(); g.arc(320, 240, 120, 0, 7); g.fill();
  const image = await RawImage.fromCanvas(cv);
  const msg = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: 'What is in this image?' }] }];
  const text = proc.apply_chat_template(msg, { add_generation_prompt: true });

  const measure = async (split, edge) => {
    const ip = proc.image_processor;
    ip.do_image_splitting = split;
    ip.size = { longest_edge: edge };
    ip.max_image_size = { longest_edge: 512 };
    if (ip.config) Object.assign(ip.config, {
      do_image_splitting: split, size: ip.size, max_image_size: ip.max_image_size });
    const inp = await proc(text, [image], { do_image_splitting: split, size: ip.size });
    return { tokens: inp.input_ids.dims.at(-1), images: inp.pixel_values.dims[1],
             bytes: inp.pixel_values.dims.reduce((a, b) => a * b, 1) * 4 };
  };
  return { shipped: await measure(true, 2048), clamped: await measure(false, 512) };
});

console.log('\n-- what the shipped defaults would do --');
// Not asserted as "correct" — asserted as the reason the clamp is not optional.
// If a future version of the model ships saner defaults this fails loudly and
// the clamp can be revisited rather than cargo-culted.
ok('shipped defaults split one photo into many sub-images',
   r.shipped.images > 8, `${r.shipped.images} images, ${(r.shipped.bytes / 1e6).toFixed(1)} MB tensor`);
ok('shipped defaults cost hundreds of prompt tokens',
   r.shipped.tokens > 500, `${r.shipped.tokens} tokens`);

console.log('\n-- the clamp Analyze applies --');
ok('one photograph becomes exactly one tile', r.clamped.images === 1, `${r.clamped.images}`);
ok('prompt fits in a couple of hundred tokens',
   r.clamped.tokens < 200, `${r.clamped.tokens} tokens`);
ok('input tensor is a few MB, not tens',
   r.clamped.bytes < 6e6, `${(r.clamped.bytes / 1e6).toFixed(1)} MB`);
ok('the clamp is worth at least 5x on prompt size',
   r.shipped.tokens / r.clamped.tokens >= 5,
   `${(r.shipped.tokens / r.clamped.tokens).toFixed(1)}x  (${r.shipped.tokens} -> ${r.clamped.tokens})`);
ok('the clamp is worth at least 5x on input memory',
   r.shipped.bytes / r.clamped.bytes >= 5,
   `${(r.shipped.bytes / r.clamped.bytes).toFixed(1)}x  (${(r.shipped.bytes/1e6).toFixed(1)} -> ${(r.clamped.bytes/1e6).toFixed(1)} MB)`);

ok('no page errors', errs.length === 0, errs.join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
