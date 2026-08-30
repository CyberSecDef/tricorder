/**
 * watchPosition wrapper (§7). Notes that bit us or will:
 *  - `heading` and `speed` are null when stationary; they are GPS-derived, not
 *    compass-derived. The nav instrument falls back to webkitCompassHeading.
 *  - `altitude` is ±10-30 m. Labelled unreliable in the UI.
 *  - Chrome/Edge on iOS also need the *app* to hold the OS location permission,
 *    and a denial there is indistinguishable from a page-level denial — so the
 *    error state has to offer both remedies.
 */

import { SensorStream } from './stream';

export interface GeoSample {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy radius, metres (68% confidence). */
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  /** Degrees from true north. Null when stationary. */
  heading: number | null;
  /** m/s. Null when stationary. */
  speed: number | null;
  timestamp: number;
}

export interface GeoError {
  code: number;
  message: string;
  kind: 'denied' | 'unavailable' | 'timeout' | 'unsupported';
}

let lastError: GeoError | null = null;
export const geoError = (): GeoError | null => lastError;

const OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15000,
};

export const geo = new SensorStream<GeoSample>((emit) => {
  if (!('geolocation' in navigator)) {
    lastError = { code: -1, message: 'Geolocation API unavailable', kind: 'unsupported' };
    return () => {};
  }

  const id = navigator.geolocation.watchPosition(
    (p) => {
      lastError = null;
      const c = p.coords;
      emit({
        latitude: c.latitude,
        longitude: c.longitude,
        accuracy: c.accuracy,
        altitude: c.altitude,
        altitudeAccuracy: c.altitudeAccuracy,
        heading: c.heading,
        speed: c.speed,
        timestamp: p.timestamp,
      });
    },
    (e) => {
      lastError = {
        code: e.code,
        message: e.message,
        kind:
          e.code === 1 ? 'denied'
          : e.code === 2 ? 'unavailable'
          : 'timeout',
      };
    },
    OPTIONS,
  );

  return () => navigator.geolocation.clearWatch(id);
});

/** Fix quality bucket derived from the accuracy radius. */
export function fixQuality(accuracy: number): { label: string; level: 0 | 1 | 2 | 3 } {
  if (accuracy <= 5) return { label: 'EXCELLENT', level: 3 };
  if (accuracy <= 15) return { label: 'GOOD', level: 2 };
  if (accuracy <= 50) return { label: 'COARSE', level: 1 };
  return { label: 'POOR', level: 0 };
}

/** Decimal degrees to degrees/minutes/seconds. */
export function toDMS(deg: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (deg >= 0 ? 'N' : 'S') : deg >= 0 ? 'E' : 'W';
  const a = Math.abs(deg);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = (mFloat - m) * 60;
  return `${d}° ${String(m).padStart(2, '0')}′ ${s.toFixed(2).padStart(5, '0')}″ ${hemi}`;
}
