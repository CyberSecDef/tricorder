/** Minimal 3-vector helpers. Device coordinates throughout: X right, Y toward
 *  the top edge of the screen, Z out of the screen toward the viewer. */

export interface Vec3 { x: number; y: number; z: number }

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export function normalize(a: Vec3): Vec3 {
  const l = len(a);
  return l > 1e-9 ? scale(a, 1 / l) : vec(0, 0, 0);
}

/** Exponential moving average toward `target`, with `alpha` in [0,1]. */
export const lerp = (a: Vec3, target: Vec3, alpha: number): Vec3 => ({
  x: a.x + (target.x - a.x) * alpha,
  y: a.y + (target.y - a.y) * alpha,
  z: a.z + (target.z - a.z) * alpha,
});

export const DEG = 180 / Math.PI;
export const RAD = Math.PI / 180;

/** Smoothing factor for a first-order low-pass with time constant `tau`
 *  seconds, sampled at `dt` seconds. Robust to the jittery dt iOS gives us. */
export function emaAlpha(dt: number, tau: number): number {
  if (!(dt > 0) || !(tau > 0)) return 1;
  return 1 - Math.exp(-dt / tau);
}

/** Wrap to [0, 360). */
export const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

/** Signed shortest angular difference a - b, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = wrap360(a - b);
  if (d > 180) d -= 360;
  return d;
}

/**
 * Circular EMA for headings. Averaging degrees directly glitches badly across
 * the 0/360 seam (359° and 1° average to 180°), so we average unit vectors.
 */
export class CircularEMA {
  private x = 0;
  private y = 0;
  private primed = false;

  update(deg: number, alpha: number): number {
    const r = deg * RAD;
    const cx = Math.cos(r);
    const cy = Math.sin(r);
    if (!this.primed) {
      this.x = cx; this.y = cy; this.primed = true;
    } else {
      this.x += (cx - this.x) * alpha;
      this.y += (cy - this.y) * alpha;
    }
    return this.value;
  }

  get value(): number { return wrap360(Math.atan2(this.y, this.x) * DEG); }
  /** Vector length in [0,1]; low values mean the input is wandering. */
  get coherence(): number { return Math.hypot(this.x, this.y); }
  reset(): void { this.primed = false; this.x = this.y = 0; }
}
