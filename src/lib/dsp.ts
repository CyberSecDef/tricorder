/** Small DSP kit. No dependencies — everything here is used by more than one
 *  instrument, and the payload budget (§3) rules out pulling in a library. */

/** In-place iterative radix-2 FFT. `re`/`im` must be the same power-of-two length. */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const ang = step * k;
        const wr = Math.cos(ang);
        const wi = Math.sin(ang);
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
      }
    }
  }
}

/** Magnitude spectrum of a real signal — returns the n/2 non-redundant bins. */
export function magnitudeSpectrum(signal: Float32Array): Float32Array {
  const n = signal.length;
  const re = Float32Array.from(signal);
  const im = new Float32Array(n);
  fft(re, im);
  const half = n >> 1;
  const out = new Float32Array(half);
  for (let i = 0; i < half; i++) out[i] = Math.hypot(re[i], im[i]) / half;
  return out;
}

/** Hann window, cached by length. */
const hannCache = new Map<number, Float32Array>();
export function hann(n: number): Float32Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Parabolic interpolation around a spectral peak. Gives sub-bin frequency
 * resolution, which is what makes the spectrum analyzer usable as a tuner.
 * Returns the fractional bin offset in [-0.5, 0.5].
 */
export function parabolicPeak(mag: ArrayLike<number>, i: number): number {
  if (i <= 0 || i >= mag.length - 1) return 0;
  const a = mag[i - 1], b = mag[i], c = mag[i + 1];
  const denom = a - 2 * b + c;
  if (Math.abs(denom) < 1e-12) return 0;
  const d = (0.5 * (a - c)) / denom;
  return Math.abs(d) <= 1 ? d : 0;
}

/**
 * One-pole high-pass, used to strip residual DC/drift from the accelerometer.
 * iOS delivers samples on a jittery clock, so the coefficient is recomputed
 * from the actual dt of each sample rather than assumed fixed (§7).
 */
export class HighPass {
  private prevIn = 0;
  private prevOut = 0;
  private primed = false;
  constructor(public cutoffHz: number) {}

  process(x: number, dt: number): number {
    if (!this.primed) { this.prevIn = x; this.prevOut = 0; this.primed = true; return 0; }
    const rc = 1 / (2 * Math.PI * this.cutoffHz);
    const a = rc / (rc + Math.max(dt, 1e-4));
    const y = a * (this.prevOut + x - this.prevIn);
    this.prevIn = x;
    this.prevOut = y;
    return y;
  }
  reset(): void { this.primed = false; }
}

/** Fixed-capacity ring buffer of numbers, with in-order readout. */
export class RingBuffer {
  private buf: Float32Array;
  private head = 0;
  private filled = 0;
  constructor(public readonly capacity: number) { this.buf = new Float32Array(capacity); }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  get length(): number { return this.filled; }

  /** Oldest-to-newest copy. Pass `into` to avoid reallocating every frame. */
  toArray(into?: Float32Array): Float32Array {
    const out = into && into.length === this.filled ? into : new Float32Array(this.filled);
    const start = (this.head - this.filled + this.capacity) % this.capacity;
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }

  /** Newest `n` samples, oldest-first, zero-padded at the front if short. */
  tail(n: number, into?: Float32Array): Float32Array {
    const out = into && into.length === n ? into : new Float32Array(n);
    out.fill(0);
    const take = Math.min(n, this.filled);
    const start = (this.head - take + this.capacity) % this.capacity;
    for (let i = 0; i < take; i++) out[n - take + i] = this.buf[(start + i) % this.capacity];
    return out;
  }

  clear(): void { this.head = 0; this.filled = 0; this.buf.fill(0); }
}

export const rms = (a: ArrayLike<number>): number => {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
};

/** Great-circle distance in metres. */
export function haversine(
  lat1: number, lon1: number, lat2: number, lon2: number,
): number {
  const R = 6371008.8; // IUGG mean earth radius
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
