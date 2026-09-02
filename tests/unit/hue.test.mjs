/* Synthetic scenes of known colour. If a blue image does not produce a blue
 * peak and nothing else, the instrument would be decorative rather than a
 * measurement. */
import { execSync } from 'node:child_process';

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/lib/huespectrum.ts --outfile=tests/.tmp/hue.js --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const { hueDistribution, binHue, hueToWavelength, BINS, HUE_SPAN } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/hue.js')).href);

let pass=0, fail=0;
const ok = (label, cond, detail='') => { console.log(`  ${cond?'PASS':'FAIL'}  ${label}${detail?'  — '+detail:''}`); cond?pass++:fail++; };

/** Build an RGBA buffer from a list of [r,g,b] repeated. */
function scene(colors, n = 2000) {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const c = colors[i % colors.length];
    d[i*4] = c[0]; d[i*4+1] = c[1]; d[i*4+2] = c[2]; d[i*4+3] = 255;
  }
  return d;
}
const peakHue = d => { const r = hueDistribution(d); return r.peakBin < 0 ? null : binHue(r.peakBin); };

console.log('\nsingle-colour scenes land on the right hue:');
for (const [name, rgb, expect] of [
  ['pure red',    [255,0,0],     0],
  ['orange',      [255,128,0],   30],
  ['yellow',      [255,255,0],   60],
  ['green',       [0,255,0],     120],
  ['cyan',        [0,255,255],   180],
  ['blue',        [0,0,255],     240],
]) {
  const h = peakHue(scene([rgb]));
  ok(name, h !== null && Math.abs(h - expect) < 6, `peak hue ${h?.toFixed(0)}, expected ~${expect}`);
}

console.log('\nabsent colours are actually absent:');
{
  const r = hueDistribution(scene([[0,0,255]]));
  const redBins = [...r.bins.slice(0, 6)];
  const blueBin = Math.floor((240/HUE_SPAN)*BINS);
  ok('blue room has a blue peak', r.bins[blueBin] > 0.9);
  ok('blue room has NO red', redBins.every(v => v === 0), `red bins: ${redBins.map(v=>v.toFixed(2)).join(',')}`);
}

console.log('\nmixed scene shows both, in proportion:');
{
  // Three parts blue to one part yellow.
  const r = hueDistribution(scene([[0,0,255],[0,0,255],[0,0,255],[255,255,0]]));
  const blueBin = Math.floor((240/HUE_SPAN)*BINS), yellowBin = Math.floor((60/HUE_SPAN)*BINS);
  ok('both present', r.bins[blueBin] > 0 && r.bins[yellowBin] > 0);
  ok('blue dominates', r.bins[blueBin] > r.bins[yellowBin], `blue ${r.bins[blueBin].toFixed(2)} vs yellow ${r.bins[yellowBin].toFixed(2)}`);
}

console.log('\ngreys and near-blacks are excluded, not smeared across the spectrum:');
{
  const r = hueDistribution(scene([[128,128,128]]));
  ok('grey is achromatic', r.achromatic > 0.99 && r.peakBin === -1, `achromatic ${(r.achromatic*100).toFixed(0)}%`);
  const dark = hueDistribution(scene([[6,0,10]]));
  ok('near-black excluded', dark.achromatic > 0.99, `achromatic ${(dark.achromatic*100).toFixed(0)}%`);
}

console.log('\nnon-spectral purples counted separately, not faked onto the axis:');
{
  const r = hueDistribution(scene([[255,0,255]]));   // magenta, hue 300
  ok('magenta is non-spectral', r.nonSpectral > 0.99 && r.peakBin === -1, `nonSpectral ${(r.nonSpectral*100).toFixed(0)}%`);
}

console.log('\nwavelength labels run the right way:');
{
  const wRed = hueToWavelength(0), wGreen = hueToWavelength(120), wViolet = hueToWavelength(280);
  ok('red is longest', wRed > wGreen && wGreen > wViolet, `${wRed} > ${wGreen} > ${wViolet} nm`);
  ok('red near 700 nm', Math.abs(wRed - 700) < 5);
  ok('violet near 405 nm', Math.abs(wViolet - 405) < 5);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
