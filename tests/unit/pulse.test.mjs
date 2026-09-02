/* Recover known heart rates from synthetic PPG. The real signal is a ~1%
 * pulsatile component riding on a large DC level with drift, so the tests
 * reproduce that shape rather than a clean sinusoid. */
import { execSync } from 'node:child_process';

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/lib/pulse.ts --outfile=tests/.tmp/pulse.js --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const { estimateRate, BandPass } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/pulse.js')).href);

const SR = 30, N = 512;   // 30 Hz for 17 s, as the instrument samples
let pass = 0, fail = 0;

function synth(bpm, { noise = 0, drift = 0, dc = 180, amp = 0.012 } = {}) {
  const bp = new BandPass();
  const out = new Float32Array(N);
  const f = bpm / 60;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    // A pulse is not a sinusoid: sharp systolic upstroke, dicrotic notch.
    const phase = 2 * Math.PI * f * t;
    const pulse = Math.sin(phase) + 0.35 * Math.sin(2 * phase + 0.6);
    const raw = dc * (1 - amp * pulse) + drift * t + (Math.random() * 2 - 1) * noise;
    out[i] = bp.process(raw, 1 / SR);
  }
  return out;
}

const check = (bpm, opts, tolBpm = 2.5) => {
  const r = estimateRate(synth(bpm, opts), SR);
  if (!r) { console.log(`  FAIL  ${bpm} bpm — no estimate`); fail++; return; }
  const err = Math.abs(r.bpm - bpm);
  const ok = err <= tolBpm;
  const desc = Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ') || 'clean';
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${String(bpm).padStart(3)} bpm  ${desc.padEnd(22)} -> ${r.bpm.toFixed(1)} bpm  (err ${err.toFixed(1)}, confidence ${r.confidence.toFixed(1)}x)`);
  ok ? pass++ : fail++;
};

console.log(`\nresolution: ${(SR / N * 60).toFixed(2)} bpm per bin, before interpolation\n`);
console.log('across the plausible human range:');
for (const bpm of [45, 60, 72, 90, 120, 160, 200]) check(bpm, {});

console.log('\nwith the impairments a real finger produces:');
check(72, { noise: 0.4 });
check(72, { drift: 8 });                 // torch warming / finger settling
check(72, { noise: 0.4, drift: 8 });
check(58, { amp: 0.004 });               // weak perfusion
check(100, { noise: 1.2 }, 4);           // heavy sensor noise

console.log('\nrejection:');
{
  // Pure noise must not produce a confident answer.
  const bp = new BandPass();
  const junk = new Float32Array(N);
  for (let i = 0; i < N; i++) junk[i] = bp.process(180 + (Math.random() * 2 - 1) * 3, 1 / SR);
  const r = estimateRate(junk, SR);
  const ok = !r || r.confidence < 6;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  pure noise -> confidence ${r ? r.confidence.toFixed(1) : 'none'}x (a real pulse scores far higher)`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
