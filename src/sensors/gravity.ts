/**
 * The gravity-down unit vector, in device coordinates.
 *
 * §7 warns that the sign convention of `accelerationIncludingGravity` differs
 * between iOS and the W3C spec, and tells us not to trust a remembered
 * polarity. So: we assume nothing at build time. `SIGN` is resolved at runtime
 * by a calibration the user runs once (Core → Gravity sign convention), the
 * result is persisted, and until they do we run on a documented assumption
 * that is clearly flagged as unverified in the UI.
 *
 * OBSERVED — §11 q.1 is answered, on iPhone / iOS 26.6.1:
 *   Flat on a table, screen up, accelerationIncludingGravity read
 *   (-0.03, 0.21, -9.80). z is NEGATIVE, so this engine reports the iOS
 *   convention, not the W3C one, and SIGN = +1. The 0.21 on y is the table,
 *   not the phone.
 *
 * That confirms the default below rather than overturning it — but it was
 * worth measuring, because the two conventions differ only in sign and a
 * wrong guess would have silently inverted pitch, roll, and every ray
 * derivation in the floor-plane rangefinder.
 *
 * Reasoning: with the phone flat and screen up, "down" in device coordinates
 * is (0, 0, -1), because +Z points out of the screen at the ceiling.
 *   - If the raw reading is (0, 0, -9.81), then gDown = +normalize(raw)  → SIGN = +1
 *   - If the raw reading is (0, 0, +9.81), then gDown = -normalize(raw)  → SIGN = -1
 * The default below is the iOS convention; the calibration confirms or flips it.
 */

import { motion } from './motion';
import { SensorStream } from './stream';
import { normalize, lerp, len, emaAlpha, vec, DEG, type Vec3 } from '../lib/vec';
import * as storage from '../lib/storage';

const KEY = 'gravitySign';

export interface GravityCalibration {
  sign: 1 | -1;
  /** The raw flat-on-table vector we derived it from, for the record. */
  observed: Vec3 | null;
  verified: boolean;
}

let cal: GravityCalibration = {
  sign: storage.load<1 | -1>(KEY, 1),
  observed: storage.load<Vec3 | null>(KEY + ':observed', null),
  verified: storage.load<boolean>(KEY + ':verified', false),
};

export const calibration = (): GravityCalibration => ({ ...cal });

/**
 * Resolve the sign from a flat, screen-up reading. Call with the phone
 * face-up on a level surface.
 */
export function calibrateFromFlat(observed: Vec3): GravityCalibration {
  // Screen-up means gDown is (0,0,-1). Pick the sign that makes it so.
  const sign: 1 | -1 = observed.z <= 0 ? 1 : -1;
  cal = { sign, observed, verified: true };
  storage.save(KEY, sign);
  storage.save(KEY + ':observed', observed);
  storage.save(KEY + ':verified', true);
  return calibration();
}

export function resetCalibration(): void {
  cal = { sign: 1, observed: null, verified: false };
  storage.remove(KEY);
  storage.remove(KEY + ':observed');
  storage.remove(KEY + ':verified');
}

export interface GravitySample {
  /** Unit vector pointing toward the earth, in device coordinates. */
  down: Vec3;
  /** Magnitude of the smoothed raw vector, m/s². ~9.81 when at rest. */
  magnitude: number;
  /** Tilt of the screen's up-axis above horizontal, degrees. 0 = flat. */
  pitch: number;
  /** Roll about the screen's up-axis, degrees. 0 = flat, ±180 = face down. */
  roll: number;
  /** True while |magnitude - 9.81| is small — i.e. not being shaken. */
  settled: boolean;
}

/** ~0.35 s time constant: fast enough to feel live, slow enough to reject taps. */
const TAU = 0.35;
const G = 9.80665;

/**
 * Low-passed gravity. Derived from `motion`, so it is a stream in its own
 * right and inherits the same refcounting — the compass and (later) the
 * rangefinder both use it without duplicating the filter.
 */
export const gravity = new SensorStream<GravitySample>((emit) => {
  let filtered: Vec3 | null = null;

  return motion.subscribe((m) => {
    if (!m.accelG) return;
    filtered = filtered === null
      ? m.accelG
      : lerp(filtered, m.accelG, emaAlpha(m.dt, TAU));

    const magnitude = len(filtered);
    if (magnitude < 1e-3) return;

    const down = normalize({
      x: filtered.x * cal.sign,
      y: filtered.y * cal.sign,
      z: filtered.z * cal.sign,
    });

    // Both formulas are stated in §8.3 as needing empirical verification
    // against a real bubble level. Flat screen-up gives down = (0,0,-1):
    //   pitch = atan2(0, 1) = 0, roll = atan2(0, 1) = 0.  Verify on device.
    const pitch = Math.atan2(-down.y, Math.hypot(down.x, down.z)) * DEG;
    const roll = Math.atan2(down.x, -down.z) * DEG;

    emit({
      down,
      magnitude,
      pitch,
      roll,
      settled: Math.abs(magnitude - G) < 0.5,
    });
  });
});

/** Fallback for screens that render before the first sample arrives. */
export const FLAT_DOWN: Vec3 = vec(0, 0, -1);
