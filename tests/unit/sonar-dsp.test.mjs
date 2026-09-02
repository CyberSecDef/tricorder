/* Matched filter against synthetic echoes at known ranges. If this cannot
 * recover a range it knows the answer to, nothing on a phone will. */
import { execSync } from 'node:child_process';

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/lib/dsp.ts --outfile=tests/.tmp/dsp.js --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const { makeChirp, matchedFilter, lagToRange, rangeToLag, SPEED_OF_SOUND } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/dsp.js')).href);

const SR = 48000, DUR = 0.010, F0 = 15000, F1 = 22000;
const CAP = 4096;           // capture window
const N = 8192;             // FFT size: >= capture + reference, so the correlation is LINEAR
const chirp = makeChirp(SR, DUR, F0, F1);
console.log(`chirp: ${chirp.length} samples (${(DUR*1000).toFixed(0)} ms), ${F0/1000}->${F1/1000} kHz`);
console.log(`range resolution: ${(SPEED_OF_SOUND/(2*SR)*1000).toFixed(2)} mm/sample`);
console.log(`capture ${CAP} samples covers ${lagToRange(CAP, SR).toFixed(2)} m one-way; FFT ${N}\n`);

let pass = 0, fail = 0;
function tryRange(trueM, { noise = 0, leak = true, atten = 0.3 } = {}) {
  const cap = new Float32Array(CAP);
  // Direct speaker-to-mic leak: centimetres away, so it dominates.
  if (leak) for (let i = 0; i < chirp.length; i++) cap[i + 2] += chirp[i] * 1.0;
  // The echo.
  const lag = Math.round(rangeToLag(trueM, SR));
  for (let i = 0; i < chirp.length; i++) {
    const j = i + lag;
    if (j < CAP) cap[j] += chirp[i] * atten;
  }
  if (noise) for (let i = 0; i < CAP; i++) cap[i] += (Math.random() * 2 - 1) * noise;

  const env = matchedFilter(cap, chirp, N);
  // Blank the direct path, as §8.10 requires.
  const blank = Math.round(0.0015 * SR);
  // Search only physically plausible lags. Beyond the capture window there is
  // nothing but padding and wrap.
  const maxLag = Math.min(CAP - chirp.length, Math.round(rangeToLag(8, SR)));
  let best = blank, bestV = -Infinity;
  for (let i = blank; i < maxLag; i++) if (env[i] > bestV) { bestV = env[i]; best = i; }
  const got = lagToRange(best, SR);
  const errMm = Math.abs(got - trueM) * 1000;
  const ok = errMm < 20;
  console.log(`  ${String(trueM).padStart(5)} m  ->  ${got.toFixed(3)} m   err ${errMm.toFixed(1).padStart(5)} mm  ${noise?`noise ${noise}`:''}  ${ok?'PASS':'FAIL'}`);
  ok ? pass++ : fail++;
}

console.log('clean, with the direct-path leak present:');
for (const r of [0.5, 1.0, 2.0, 3.0, 5.0]) tryRange(r);
console.log('\nwith noise:');
tryRange(1.0, { noise: 0.05 });
tryRange(2.0, { noise: 0.10 });
tryRange(1.0, { noise: 0.30, atten: 0.3 });
console.log('\nweak echo (1% amplitude) against a full-strength leak:');
tryRange(1.5, { atten: 0.01 });

// Does blanking actually matter?
console.log('\nwithout blanking, the leak wins:');
{
  const cap = new Float32Array(CAP);
  for (let i = 0; i < chirp.length; i++) cap[i + 2] += chirp[i];
  const lag = Math.round(rangeToLag(2.0, SR));
  for (let i = 0; i < chirp.length; i++) if (i + lag < CAP) cap[i + lag] += chirp[i] * 0.3;
  const env = matchedFilter(cap, chirp, N);
  let b = 0, bv = -Infinity;
  for (let i = 0; i < CAP; i++) if (env[i] > bv) { bv = env[i]; b = i; }
  console.log(`  peak lands at ${lagToRange(b, SR).toFixed(3)} m — the leak at ~0 m, not the 2.0 m target`);
}
// --- the prominence gate must pass real echoes and reject a bare skirt ------
console.log('\nprominence gate (5x) — must pass real echoes:');
{
  const med = a => { const t=[...a].sort((x,y)=>x-y); return t[t.length>>1]; };
  const lo = Math.round(0.0015*SR) + 24;
  const hi = Math.min(CAP - chirp.length, Math.round(rangeToLag(6, SR)));
  const measure = (m, atten, noise) => {
    const cap = new Float32Array(CAP);
    for (let i=0;i<chirp.length;i++) cap[i+2] += chirp[i];
    const lag = Math.round(rangeToLag(m, SR));
    for (let i=0;i<chirp.length;i++) if (i+lag<CAP) cap[i+lag] += chirp[i]*atten;
    if (noise) for (let i=0;i<CAP;i++) cap[i] += (Math.random()*2-1)*noise;
    const env = matchedFilter(cap, chirp, N);
    let b=-1, bv=-Infinity;
    for (let i=lo;i<hi-1;i++) if (env[i]>bv && env[i]>=env[i-1] && env[i]>=env[i+1]) { bv=env[i]; b=i; }
    const vals=[]; for (let i=Math.max(lo,b-220); i<Math.min(hi,b+220); i++) if (Math.abs(i-b)>=12) vals.push(env[i]);
    return { range: lagToRange(b, SR), prom: bv/med(vals) };
  };
  for (const [m, a, nz] of [[1,0.3,0],[3,0.3,0],[1.5,0.01,0],[2,0.3,0.1],[1,0.3,0.3]]) {
    const r = measure(m, a, nz);
    const ok = Math.abs(r.range-m) < 0.05 && r.prom >= 5;
    console.log(`  ${String(m).padStart(4)} m  amp ${String(a).padStart(4)}  noise ${String(nz).padStart(3)}  ->  ${r.range.toFixed(3)} m, prominence ${r.prom.toFixed(1)}x  ${ok?'PASS':'FAIL'}`);
    ok ? pass++ : fail++;
  }
  console.log('  (a bare direct-path skirt with no echo measures ~3.1x in-browser, so 5x separates them)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
