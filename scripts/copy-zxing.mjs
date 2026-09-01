/**
 * Copy the ZXing reader WebAssembly into public/zxing/.
 *
 * Same reasoning as scripts/copy-ort.mjs: self-hosted rather than fetched from
 * a CDN, so the app has no third-party runtime dependency and keeps working
 * offline. Only the READER is copied — the writer generates barcodes, which
 * this app has no business doing.
 *
 * A build artefact, reproduced from node_modules, so it is gitignored.
 */
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'zxing-wasm', 'dist', 'reader');
const dest = join(root, 'public', 'zxing');

if (!existsSync(src)) {
  console.error(`copy-zxing: ${src} not found - run npm install first.`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
const file = 'zxing_reader.wasm';
copyFileSync(join(src, file), join(dest, file));
console.log(`copy-zxing: ${file}  ${(statSync(join(src, file)).size / 1e6).toFixed(2)} MB into public/zxing/`);
