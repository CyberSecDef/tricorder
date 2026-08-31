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

/**
 * Solve for BOTH field of view and camera height from two tapped points at
 * known distances.
 *
 * Why this exists: a single known distance cannot separate the two unknowns.
 * A reading 12% low is equally well explained by a field of view that is too
 * wide or a camera height that is too small, and calibrating one while the
 * other is wrong bakes the error in — the single-point fit then reads
 * correctly at the calibration distance and wrongly everywhere else, which is
 * worse than not calibrating, because it looks trustworthy.
 *
 * Two points remove the degeneracy. Taking h from the first equation,
 *   h = D1 · tan θ1(f)
 * and substituting into the second gives one equation in f alone:
 *   tan θ1(f) / tan θ2(f) = D2 / D1
 * which is solved by bisection, after which h follows directly.
 *
 * The two taps must be at genuinely different depression angles — that is what
 * makes the ratio informative — so use distances that differ by at least a
 * factor of ~1.6. The camera height must not change between them.
 */
export interface TwoPointFit {
  fovDeg: number;
  height: number;
  /**
   * How far the fitted FOV moves when the two input distances are perturbed
   * by ±1% — about what a tape measure plus a tap is good for — in degrees.
   * This is the honest 1σ on the calibrated FOV and should be used as such
   * rather than asserting some flattering fixed figure. This is the conditioning of the fit, and it matters:
   * the FOV information comes from the two taps sitting at different places
   * IN THE FRAME, not from the phone being tilted differently between them.
   * Tilt changes the depression angle without exercising the field of view at
   * all, so two taps at similar frame positions leave the ratio nearly flat
   * in f and a 1% distance error swings the answer by tens of degrees.
   */
  fovSensitivity: number;
  /** Same perturbation, effect on height, in metres. */
  heightSensitivity: number;
  /** False when the fit is too sensitive to be trusted. */
  wellConditioned: boolean;
}

/**
 * Beyond this the fit is not measuring the optics, it is amplifying noise.
 * Set equal to the uncertainty we carry when NOT calibrated: a calibration
 * worth keeping has to beat the nominal guess it replaces.
 */
export const MAX_FOV_SENSITIVITY_DEG = 8;

export function solveFovAndHeight(
  a: { u: number; v: number; gDown: Vec3; distance: number },
  b: { u: number; v: number; gDown: Vec3; distance: number },
  aspect: number,
): TwoPointFit | null {
  const base = fitOnce(a, b, aspect);
  if (!base) return null;

  // Perturb the two measured distances in opposition, which is the worst case
  // for the ratio the fit depends on, and see how far the answer moves.
  const P = 0.01;
  const lo = fitOnce({ ...a, distance: a.distance * (1 + P) }, { ...b, distance: b.distance * (1 - P) }, aspect);
  const hi = fitOnce({ ...a, distance: a.distance * (1 - P) }, { ...b, distance: b.distance * (1 + P) }, aspect);

  // A perturbation that pushes the fit out of solvable range is itself a
  // statement that the fit is on a knife edge.
  const fovSensitivity = lo && hi ? Math.abs(hi.fovDeg - lo.fovDeg) / 2 : Infinity;
  const heightSensitivity = lo && hi ? Math.abs(hi.height - lo.height) / 2 : Infinity;

  return {
    ...base,
    fovSensitivity,
    heightSensitivity,
    wellConditioned: fovSensitivity <= MAX_FOV_SENSITIVITY_DEG,
  };
}

function fitOnce(
  a: { u: number; v: number; gDown: Vec3; distance: number },
  b: { u: number; v: number; gDown: Vec3; distance: number },
  aspect: number,
): { fovDeg: number; height: number } | null {
  // tan θ at unit height; the height cancels out of the ratio entirely.
  const tanTheta = (p: { u: number; v: number; gDown: Vec3 }, fovDeg: number): number | null => {
    const tanH = Math.tan((fovDeg * Math.PI) / 360);
    const sol = solveFloor(frameRay(p.u, p.v, tanH, tanH * aspect), p.gDown, 1);
    if (!sol) return null;
    return 1 / sol.horizontal;   // horizontal = 1/tanθ when height is 1
  };

  const target = b.distance / a.distance;
  const ratio = (fovDeg: number): number | null => {
    const t1 = tanTheta(a, fovDeg);
    const t2 = tanTheta(b, fovDeg);
    if (t1 === null || t2 === null || !(t2 > 1e-9)) return null;
    return t1 / t2;
  };

  // A shallow tap goes above the horizon at wide fields of view, so the ends
  // of the nominal 20–130° bracket may be undefined. Scan for a sub-interval
  // where both taps resolve AND the ratio crosses the target, rather than
  // testing only the endpoints and giving up.
  const STEP = 0.5;
  let lo = NaN, hi = NaN, increasing = false;
  let prevF = NaN, prevR: number | null = null;
  for (let f = 20; f <= 130 + 1e-9; f += STEP) {
    const r = ratio(f);
    if (r !== null && prevR !== null) {
      if ((prevR - target) * (r - target) <= 0) {
        lo = prevF; hi = f; increasing = r > prevR;
        break;
      }
    }
    prevF = f; prevR = r;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const r = ratio(mid);
    if (r === null) return null;
    if (increasing ? r < target : r > target) lo = mid; else hi = mid;
  }
  const fovDeg = (lo + hi) / 2;

  const t1 = tanTheta(a, fovDeg);
  if (t1 === null || !(t1 > 1e-9)) return null;
  const height = a.distance * t1;
  if (!(height > 0.2 && height < 3.5)) return null;   // physically implausible

  return { fovDeg, height };
}
