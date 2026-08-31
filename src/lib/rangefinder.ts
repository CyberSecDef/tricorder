/**
 * Floor-plane ranging geometry (§8.6).
 *
 * Principle: with the camera a known height h above a flat floor, a ray
 * depressed θ below horizontal meets the floor at horizontal distance h/tanθ.
 * That is genuinely metric — no model, no scale ambiguity — for any point
 * where an object meets the floor.
 *
 * Kept separate from the UI so it can be tested against closed-form cases.
 * Device coordinates: X right, Y toward the top of the screen, Z out of the
 * screen. The rear camera looks along −Z.
 */

import { normalize, dot, type Vec3 } from './vec';

/** Beyond this the 1/tanθ error growth makes a reading meaningless (§8.6). */
export const MAX_RANGE_M = 8;

/**
 * Total angular uncertainty, degrees (1σ). Dominated by gravity-vector noise
 * and tap precision; the calibrated FOV contributes on top of this. Chosen to
 * be honest rather than flattering — the uncertainty band is the point.
 */
export const SIGMA_THETA_DEG = 1.0;

export interface FloorSolution {
  /** Depression below horizontal, degrees. Always > 0 for a valid solution. */
  thetaDeg: number;
  /** Distance along the floor from directly beneath the camera, metres. */
  horizontal: number;
  /** Straight-line distance from camera to the point, metres. */
  slant: number;
  /** 1σ uncertainty on the horizontal distance, metres. */
  sigma: number;
}

/**
 * Build the view ray for a normalised frame coordinate.
 * `tanH`/`tanV` are tan(hfov/2) and tan(vfov/2) of the frame AS DISPLAYED.
 */
export function frameRay(u: number, v: number, tanH: number, tanV: number): Vec3 {
  return normalize({ x: u * tanH, y: v * tanV, z: -1 });
}

/**
 * Intersect a ray with the floor plane. Returns null when the ray is at or
 * above the horizon, where there is no intersection to find.
 */
export function solveFloor(ray: Vec3, gDown: Vec3, height: number): FloorSolution | null {
  // dot(ray, ĝ_down) is sin of the angle below horizontal, because ĝ_down is
  // the unit normal of the horizontal plane.
  const sinTheta = dot(ray, gDown);
  if (!(sinTheta > 1e-6)) return null;          // at or above the horizon

  // Straight down (sinTheta = 1) is not an error: it is the point directly
  // beneath the camera, at zero horizontal distance. Clamp for asin domain
  // safety and let the arithmetic produce that answer.
  const theta = Math.asin(Math.min(1, sinTheta));
  const tanTheta = Math.tan(theta);
  if (!(tanTheta > 1e-9)) return null;

  const horizontal = height / tanTheta;
  const slant = height / sinTheta;

  // d = h/tanθ  ⇒  |dd/dθ| = h/sin²θ. Error grows as 1/tan θ, which is why
  // this degrades sharply with distance and why we refuse to print a number
  // past MAX_RANGE_M.
  const sigma = (height * (SIGMA_THETA_DEG * Math.PI / 180)) / (sinTheta * sinTheta);

  return { thetaDeg: (theta * 180) / Math.PI, horizontal, slant, sigma };
}

/**
 * Solve for the horizontal field of view that makes a tap at (u,v) read a
 * known distance.
 *
 * FOV is the dominant error source and getUserMedia may crop relative to the
 * native camera, so it must never be hardcoded (§8.6). Distance is monotonically
 * decreasing in tan(hfov/2) for a downward tap — a wider field puts the same
 * pixel further off-axis, so the ray is more depressed and the floor is nearer
 * — which makes bisection safe.
 *
 * `aspect` is frameHeight/frameWidth, relating vfov to hfov for a pinhole.
 * Returns the horizontal FOV in degrees, or null if no FOV in range fits.
 */
export function solveFovDeg(
  u: number,
  v: number,
  gDown: Vec3,
  height: number,
  measuredHorizontal: number,
  aspect: number,
): number | null {
  const distanceFor = (fovDeg: number): number | null => {
    const tanH = Math.tan((fovDeg * Math.PI) / 360);
    const sol = solveFloor(frameRay(u, v, tanH, tanH * aspect), gDown, height);
    return sol ? sol.horizontal : null;
  };

  let lo = 20, hi = 130;
  const dLo = distanceFor(lo);
  const dHi = distanceFor(hi);
  // A null at either end means the ray never reaches the floor there, so the
  // measurement cannot constrain the FOV.
  if (dLo === null || dHi === null) return null;
  if (measuredHorizontal > dLo || measuredHorizontal < dHi) return null;  // outside the bracket

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const d = distanceFor(mid);
    if (d === null) return null;
    if (d > measuredHorizontal) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
