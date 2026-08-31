/**
 * The gyro/compass residual — the signal Instrument 7 is built on.
 *
 * The gyroscope is magnetically immune; the compass is not. Integrate yaw rate
 * about true vertical over a short window, compare it against the actual
 * change in compass heading, and the difference is what the field did that the
 * device did not. §8.7 calls this signal B.
 *
 * MEASURED on iPhone / iOS 26.6.1 (§11 q.2, via the probe screen):
 *   phone resting on a table    residual RMS 0.021°, p95 0.017°
 *   neodymium magnet at the top  peak 14.28°
 *   → 691x the noise floor. Core Motion does NOT damp this.
 *
 * Two hard-won details are baked in here rather than left to callers:
 *
 *   1. Yaw rate is dot(omega, gDown), never rotationRate.alpha. Alpha is only
 *      yaw when the phone lies flat on its back.
 *   2. The detrend EMA must be resettable. Its 25 s time constant otherwise
 *      carries charge across measurement sessions; that inflated one recorded
 *      baseline noise floor by a factor of 627.
 */

import { SensorStream } from './stream';
import { motion } from './motion';
import { orientation } from './orientation';
import { gravity } from './gravity';
import { dot, angleDelta, type Vec3 } from '../lib/vec';
import * as storage from '../lib/storage';

/** Window over which predicted and actual heading change are compared. */
export const WINDOW_S = 1.5;
/** Detrend time constant for gyro bias (§8.7 step 6). */
export const DETREND_TAU = 25;

export interface ResidualSample {
  /** Seconds since the stream started. */
  t: number;
  /** Detrended residual, degrees. The anomaly signal. */
  residual: number;
  /** Before bias detrending, degrees. */
  residualRaw: number;
  /** Yaw rate about true vertical, deg/s. */
  yawRate: number;
  /** Cumulative |yaw| since the stream started, degrees. */
  rotated: number;
  heading: number | null;
  /** webkitCompassAccuracy. Negative means invalid. */
  accuracy: number;
  /** Sign convention currently relating yaw rate to increasing heading. */
  sign: 1 | -1;
  /** Confidence in that sign, 0..1. */
  signConfidence: number;
}

// --- module state, reset via resetFilters() ------------------------------
let sign: 1 | -1 = storage.load<1 | -1>('residual:sign', 1);
let signEvidence = storage.load<number>('residual:signEvidence', 0);
let win: Array<{ t: number; pred: number; act: number }> = [];
let detrend = 0;
let detrendPrimed = false;
let prevHeading: number | null = null;
let clock = 0;
let rotated = 0;

/**
 * Clear the filters. Call at the start of any measurement session, otherwise
 * it inherits state from whatever the user was doing beforehand.
 */
export function resetFilters(): void {
  win = [];
  detrend = 0;
  detrendPrimed = false;
  prevHeading = null;
  rotated = 0;
}

export const currentSign = (): 1 | -1 => sign;
export const signConfidence = (): number => Math.min(1, Math.abs(signEvidence) / 400);

export const residual = new SensorStream<ResidualSample>((emit) => {
  let gDown: Vec3 | null = null;
  let heading: number | null = null;
  let accuracy = 0;

  const unGrav = gravity.subscribe((g) => { gDown = g.down; });
  const unOrient = orientation.subscribe((o) => {
    heading = o.heading;
    if (o.headingAccuracy !== null) accuracy = o.headingAccuracy;
  });

  // Everything runs on the motion clock: it is the only stream carrying a
  // trustworthy dt. Heading contributes zero on samples where it did not
  // change, which is correct — the window sums the same total either way.
  const unMotion = motion.subscribe((m) => {
    if (!m.omega || !gDown) return;
    clock += m.dt;

    const yaw = dot(m.omega, gDown) * sign;

    let actual = 0;
    if (heading !== null) {
      if (prevHeading !== null) actual = angleDelta(heading, prevHeading);
      prevHeading = heading;
    }

    win.push({ t: clock, pred: yaw * m.dt, act: actual });
    while (win.length && clock - win[0].t > WINDOW_S) win.shift();

    let sumPred = 0, sumAct = 0;
    for (const w of win) { sumPred += w.pred; sumAct += w.act; }
    const raw = sumAct - sumPred;

    const a = 1 - Math.exp(-m.dt / DETREND_TAU);
    if (!detrendPrimed) { detrend = raw; detrendPrimed = true; }
    else detrend += (raw - detrend) * a;

    // Estimate the sign from accumulated correlation rather than guessing it.
    // Only rotation carries information, so a still phone never votes.
    if (Math.abs(sumPred) > 2) {
      signEvidence += Math.sign(sumPred) === Math.sign(sumAct) ? 1 : -1;
      signEvidence = Math.max(-400, Math.min(400, signEvidence));
      if (signEvidence < -60) {
        sign = sign === 1 ? -1 : 1;
        signEvidence = 0;
        storage.save('residual:sign', sign);
        resetFilters();
      }
      storage.save('residual:signEvidence', signEvidence);
    }

    rotated += Math.abs(yaw) * m.dt;

    emit({
      t: clock,
      residual: raw - detrend,
      residualRaw: raw,
      yawRate: yaw,
      rotated,
      heading,
      accuracy,
      sign,
      signConfidence: signConfidence(),
    });
  });

  return () => { unMotion(); unOrient(); unGrav(); };
});
