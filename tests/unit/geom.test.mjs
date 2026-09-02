/* Closed-form checks on the ranging geometry. Every case here is one I can
 * work out by hand, which is the point — the instrument's whole claim is that
 * the numbers are real. */
const { execSync } = await import('node:child_process');

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/lib/rangefinder.ts --outdir=tests/.tmp --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const { frameRay, solveFloor, solveFovDeg } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/rangefinder.js')).href);

let pass = 0, fail = 0;
const near = (a, b, tol, msg) => {
  const ok = Math.abs(a - b) <= tol;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}: got ${a?.toFixed?.(4) ?? a}, want ${b}`);
  ok ? pass++ : fail++;
};

const DOWN = { x: 0, y: 0, z: -1 };          // phone held flat, screen up
const H = 1.4;

console.log('\nPhone flat, screen up — camera points straight down:');
// Centre pixel with gDown = -Z and ray = -Z: dot = 1, straight down.
// theta = 90deg, horizontal = h/tan(90) = 0.
{
  const sol = solveFloor(frameRay(0, 0, 0.6, 0.8), DOWN, H);
  near(sol.thetaDeg, 90, 1e-6, 'centre ray depression');
  near(sol.horizontal, 0, 1e-6, 'directly below the camera');
  near(sol.slant, H, 1e-6, 'slant equals the camera height');
}

console.log('\nCamera tilted so the centre ray is 45 deg below horizontal:');
// Rotate gravity instead of the camera: gDown at 45 deg from the -Z axis in
// the YZ plane. dot(ray=-Z, gDown) = cos(45) = sin(theta) -> theta = 45.
{
  const s = Math.SQRT1_2;
  const g = { x: 0, y: -s, z: -s };
  const sol = solveFloor(frameRay(0, 0, 0.6, 0.8), g, H);
  near(sol.thetaDeg, 45, 1e-6, 'depression angle');
  near(sol.horizontal, H, 1e-9, 'h/tan(45) = h');
  near(sol.slant, H * Math.SQRT2, 1e-9, 'slant = h*sqrt(2)');
}

console.log('\n30 deg depression — the textbook case:');
{
  const g = { x: 0, y: -Math.cos(Math.PI / 6), z: -Math.sin(Math.PI / 6) };
  const sol = solveFloor(frameRay(0, 0, 0.6, 0.8), g, H);
  near(sol.thetaDeg, 30, 1e-6, 'depression angle');
  near(sol.horizontal, H / Math.tan(Math.PI / 6), 1e-9, 'h/tan(30) = h*sqrt(3)');
}

console.log('\nAbove the horizon must refuse to answer:');
{
  const g = { x: 0, y: -Math.SQRT1_2, z: Math.SQRT1_2 };   // looking upward
  const sol = solveFloor(frameRay(0, 0, 0.6, 0.8), g, H);
  console.log(`  ${sol === null ? 'PASS' : 'FAIL'}  returns null instead of a number`);
  sol === null ? pass++ : fail++;
}

console.log('\nUncertainty grows as 1/tan(theta):');
{
  const mk = (deg) => solveFloor(frameRay(0, 0, .6, .8),
    { x: 0, y: -Math.cos(deg * Math.PI / 180), z: -Math.sin(deg * Math.PI / 180) }, H);
  const a = mk(45), b = mk(10);
  console.log(`  45 deg: d=${a.horizontal.toFixed(2)}m sigma=${a.sigma.toFixed(3)}m`);
  console.log(`  10 deg: d=${b.horizontal.toFixed(2)}m sigma=${b.sigma.toFixed(3)}m`);
  const ok = b.sigma > a.sigma * 5;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  sigma blows up at shallow angles`);
  ok ? pass++ : fail++;
}

console.log('\nFOV calibration round-trips:');
{
  // Pick a true FOV, synthesise what a tap would read, then recover the FOV.
  const TRUE_FOV = 68.5, aspect = 3 / 4, u = 0.12, v = -0.42;
  const g = { x: 0, y: -Math.cos(Math.PI / 9), z: -Math.sin(Math.PI / 9) };  // 20 deg down
  const tanH = Math.tan(TRUE_FOV * Math.PI / 360);
  const truth = solveFloor(frameRay(u, v, tanH, tanH * aspect), g, H);
  const recovered = solveFovDeg(u, v, g, H, truth.horizontal, aspect);
  near(recovered, TRUE_FOV, 0.01, 'recovered FOV from a known distance');
}


// --- two-point calibration ------------------------------------------------
{
  const { solveFovAndHeight } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/rangefinder.js')).href);
  console.log('\nTwo-point calibration recovers BOTH unknowns:');
  const TRUE_FOV = 62.3, TRUE_H = 1.62, aspect = 3/4;
  const tanH = Math.tan(TRUE_FOV * Math.PI / 360);
  const mk = (deg, u, v) => {
    const g = { x: 0, y: -Math.cos(deg*Math.PI/180), z: -Math.sin(deg*Math.PI/180) };
    const sol = solveFloor(frameRay(u, v, tanH, tanH*aspect), g, TRUE_H);
    return { u, v, gDown: g, distance: sol.horizontal, theta: sol.thetaDeg };
  };
  // Two genuinely different depression angles, as the doc requires.
  // Well conditioned: SAME device tilt, very different positions in frame.
  // The field-of-view information lives in the frame offset, not the tilt.
  const p1 = mk(28,  0.05, -0.62);
  const p2 = mk(28, -0.05, -0.12);
  console.log(`  synthesised taps at ${p1.distance.toFixed(3)} m and ${p2.distance.toFixed(3)} m`);
  const got = solveFovAndHeight(p1, p2, aspect);
  near(got.fovDeg, TRUE_FOV, 0.02, 'recovered FOV');
  near(got.height, TRUE_H, 0.005, 'recovered camera height');
  console.log(`  conditioning: FOV moves ±${got.fovSensitivity.toFixed(2)}° under a 2% distance error`);
  console.log(`  ${got.wellConditioned ? 'PASS' : 'FAIL'}  reported as well conditioned`);
  got.wellConditioned ? pass++ : fail++;

  // Ill conditioned: different TILTS but similar frame positions. The tilt
  // changes the depression angle without exercising the field of view, so the
  // ratio is nearly flat in f and the fit amplifies any distance error.
  const q1 = mk(32,  0.10, -0.42);
  const q2 = mk(20, -0.05, -0.30);
  const bad = solveFovAndHeight(q1, q2, aspect);
  console.log(`\n  ill-conditioned pair (different tilt, similar frame position):`);
  console.log(`    FOV moves ±${bad.fovSensitivity.toFixed(1)}° under the same 2% error`);
  const flagged = !bad.wellConditioned;
  console.log(`  ${flagged ? 'PASS' : 'FAIL'}  flagged as poorly conditioned rather than reported as fact`);
  flagged ? pass++ : fail++;

  // A single-point fit with the WRONG height must misread other distances —
  // this is the failure mode two-point calibration exists to prevent.
  const WRONG_H = 1.40;
  const badFov = solveFovDeg(p1.u, p1.v, p1.gDown, WRONG_H, p1.distance, aspect);
  const badTan = Math.tan(badFov * Math.PI / 360);
  const check = solveFloor(frameRay(p2.u, p2.v, badTan, badTan*aspect), p2.gDown, WRONG_H);
  const err = Math.abs(check.horizontal - p2.distance) / p2.distance * 100;
  console.log(`  single-point fit with a wrong height (${WRONG_H} vs ${TRUE_H}):`);
  console.log(`    exact at its own calibration point, but ${err.toFixed(1)}% off at ${p2.distance.toFixed(2)} m`);
  const ok = err > 3;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  demonstrates the degeneracy two points remove`);
  ok ? pass++ : fail++;
  console.log(`\n${pass} passed, ${fail} failed`);
}
process.exit(fail ? 1 : 0);
