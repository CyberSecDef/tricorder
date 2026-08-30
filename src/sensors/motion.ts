/**
 * devicemotion (§7). On iOS `acceleration` really does have gravity removed by
 * Core Motion's fusion, so the seismograph can use it directly.
 *
 * Sample rate is ~60 Hz but not guaranteed, and the clock jitters — always
 * integrate with `interval`, never a hardcoded dt.
 */

import { SensorStream } from './stream';
import type { Vec3 } from '../lib/vec';
import { vec } from '../lib/vec';

export interface MotionSample {
  /** m/s², gravity removed. Null if the platform does not provide it. */
  accel: Vec3 | null;
  /** m/s², gravity included. Sign convention is device-specific — see gravity.ts. */
  accelG: Vec3 | null;
  /**
   * deg/s in device axes (X, Y, Z). Per spec alpha is about Z, beta about X
   * and gamma about Y, so the mapping to a vector is (beta, gamma, alpha).
   */
  omega: Vec3 | null;
  /** Seconds between samples, from the event. */
  dt: number;
  /** performance.now() at receipt, ms. */
  t: number;
}

/** Fallback dt if the event omits `interval` (~60 Hz). */
const DEFAULT_DT = 1 / 60;

export const motion = new SensorStream<MotionSample>((emit) => {
  let lastT = performance.now();

  const onMotion = (e: DeviceMotionEvent) => {
    const now = performance.now();
    // e.interval is milliseconds. Prefer it, but sanity-clamp: a stale or
    // absent value here silently corrupts every integration downstream.
    let dt = (e.interval ?? 0) / 1000;
    if (!(dt > 0.001 && dt < 0.5)) dt = Math.min(Math.max((now - lastT) / 1000, 0.001), 0.5);
    if (!(dt > 0)) dt = DEFAULT_DT;
    lastT = now;

    emit({
      accel: toVec(e.acceleration),
      accelG: toVec(e.accelerationIncludingGravity),
      omega: e.rotationRate
        ? vec(e.rotationRate.beta ?? 0, e.rotationRate.gamma ?? 0, e.rotationRate.alpha ?? 0)
        : null,
      dt,
      t: now,
    });
  };

  window.addEventListener('devicemotion', onMotion);
  return () => window.removeEventListener('devicemotion', onMotion);
});

function toVec(a: DeviceMotionEventAcceleration | null): Vec3 | null {
  if (!a) return null;
  const { x, y, z } = a;
  if (x === null && y === null && z === null) return null;
  return vec(x ?? 0, y ?? 0, z ?? 0);
}
