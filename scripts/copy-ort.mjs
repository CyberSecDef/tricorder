/**
 * Copy the ONNX Runtime WebAssembly binaries into public/ort/ so the app can
 * serve them itself.
 *
 * Why self-host rather than use a CDN:
 *  - The installed onnxruntime-web is a dev build. Its exact version may not
 *    exist on any public CDN, and a near-miss version is a silent runtime
 *    failure rather than a 404 you would notice.
 *  - Once the model is cached, the app then works with no network at all.
 *  - It removes a third-party runtime dependency from a page that already asks
 *    for the camera.
 *
 * Not committed to git — these are build artefacts reproduced from
 * node_modules, and 39 MB of binary has no business in the history.
 */
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dest = join(root, 'public', 'ort');

// jsep is the WebGPU build and the expected path (§11 q.6: WebGPU is present
// in all three browsers). The plain build is the CPU fallback for when WebGPU
// initialisation fails at runtime despite being advertised.
// Which variant the runtime asks for is decided inside ONNX Runtime, not by
// us, and it depends on the backend AND on whether it takes an async path. In
// testing a WebGPU init failure sent it looking for `asyncify`, which was not
// present, producing a 404 and an error that named neither. Ship the three it
// can plausibly want. `jspi` is experimental and omitted.
const FILES = [
  'ort-wasm-simd-threaded.jsep.wasm',      // WebGPU — the expected path
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',  // CPU, async path
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.wasm',           // CPU, plain
  'ort-wasm-simd-threaded.mjs',
];

if (!existsSync(src)) {
  console.error(`copy-ort: ${src} not found — run npm install first.`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
let total = 0;
for (const f of FILES) {
  const from = join(src, f);
  if (!existsSync(from)) { console.warn(`copy-ort: skipping missing ${f}`); continue; }
  copyFileSync(from, join(dest, f));
  const bytes = statSync(from).size;
  total += bytes;
  console.log(`copy-ort: ${f}  ${(bytes / 1e6).toFixed(1)} MB`);
}
console.log(`copy-ort: ${(total / 1e6).toFixed(1)} MB into public/ort/`);
