/**
 * deviceorientation (§7). `deviceorientationabsolute` does not fire on iOS —
 * we use `deviceorientation` plus WebKit's `webkitCompassHeading`, which is
 * present in Safari, Chrome and Edge on iOS and absent everywhere else.
 */

import { SensorStream } from './stream';

export interface OrientationSample {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** Degrees. True north when location is available, else magnetic. */
  heading: number | null;
  /**
   * Estimated heading error in degrees. NEGATIVE means invalid/uncalibrated —
   * this is Instrument 7's cheapest anomaly signal, so we keep the raw value.
   */
  headingAccuracy: number | null;
  t: number;
}

export const orientation = new SensorStream<OrientationSample>((emit) => {
  const onOrient = (e: DeviceOrientationEvent) => {
    const wk = e as DeviceOrientationEvent & {
      webkitCompassHeading?: number;
      webkitCompassAccuracy?: number;
    };
    emit({
      alpha: e.alpha,
      beta: e.beta,
      gamma: e.gamma,
      heading: typeof wk.webkitCompassHeading === 'number' ? wk.webkitCompassHeading : null,
      headingAccuracy:
        typeof wk.webkitCompassAccuracy === 'number' ? wk.webkitCompassAccuracy : null,
      t: performance.now(),
    });
  };

  window.addEventListener('deviceorientation', onOrient);
  return () => window.removeEventListener('deviceorientation', onOrient);
});
