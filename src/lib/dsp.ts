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

/** In-place inverse FFT, via the conjugate identity. */
export function ifft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) { re[i] *= inv; im[i] = -im[i] * inv; }
}

/**
 * Linear FM chirp, Hann-windowed (§8.10).
 *
 * The window matters as much as the sweep: an unwindowed chirp has abrupt
 * ends, and those discontinuities produce range sidelobes in the matched
 * filter output that look exactly like additional targets.
 */
export function makeChirp(
  sampleRate: number, durationS: number, f0: number, f1: number,
): Float32Array {
  const n = Math.round(sampleRate * durationS);
  const out = new Float32Array(n);
  const w = hann(n);
  const k = (f1 - f0) / durationS;   // Hz per second
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Instantaneous phase is the integral of the linear frequency ramp.
    const phase = 2 * Math.PI * (f0 * t + 0.5 * k * t * t);
    out[i] = Math.sin(phase) * w[i];
  }
  return out;
}

/**
 * Matched-filter cross-correlation, returning the analytic ENVELOPE.
 *
 * Computed as X·conj(H) in the frequency domain, then the negative-frequency
 * half is zeroed and the positive half doubled before the inverse transform.
 * That produces the analytic signal, whose magnitude is the true envelope.
 *
 * The alternative — taking the absolute value of the real correlation — leaves
 * the output oscillating at the carrier, so the peak is a picket fence of
 * near-equal spikes rather than one lobe, and peak-picking lands on an
 * arbitrary member of it. That is a range error of a few millimetres per cycle
 * at these frequencies, which matters when the resolution is 3.6 mm.
 *
 * ⚠️ `n` must be a power of two AND at least `signal.length +
 * reference.length`. FFT correlation is CIRCULAR: with n merely equal to the
 * signal length, the correlation peak of anything near lag zero wraps around
 * into the far end of the array. In this application that is not a subtlety —
 * the speaker-to-microphone leak sits at lag ~0 and dominates everything, so
 * its wrapped skirt appears at maximum range and outweighs any real echo.
 * Measured: a leak peak of 89.8 put 83.2 at the last sample while the genuine
 * 2 m echo was 26.9, so peak-picking chose 14.6 m every time. Zero-padding to
 * signal+reference makes the correlation linear and the problem disappears.
 */
export function matchedFilter(
  signal: Float32Array, reference: Float32Array, n: number,
): Float32Array {
  const xr = new Float32Array(n);
  const xi = new Float32Array(n);
  const hr = new Float32Array(n);
  const hi = new Float32Array(n);
  xr.set(signal.subarray(0, Math.min(signal.length, n)));
  hr.set(reference.subarray(0, Math.min(reference.length, n)));

  fft(xr, xi);
  fft(hr, hi);

  for (let i = 0; i < n; i++) {
    const a = xr[i], b = xi[i], c = hr[i], d = -hi[i];   // conj(H)
    xr[i] = a * c - b * d;
    xi[i] = a * d + b * c;
  }

  // Analytic signal: keep DC and Nyquist, double the positive frequencies,
  // zero the negative ones.
  const half = n >> 1;
  for (let i = 1; i < half; i++) { xr[i] *= 2; xi[i] *= 2; }
  for (let i = half + 1; i < n; i++) { xr[i] = 0; xi[i] = 0; }

  ifft(xr, xi);

  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = Math.hypot(xr[i], xi[i]);
  return env;
}

/** Speed of sound in dry air at 20 °C, m/s. */
export const SPEED_OF_SOUND = 343;

/** Round-trip lag in samples to one-way range in metres. */
export const lagToRange = (lag: number, sampleRate: number): number =>
  (lag / sampleRate) * SPEED_OF_SOUND / 2;

/** One-way range in metres to round-trip lag in samples. */
export const rangeToLag = (m: number, sampleRate: number): number =>
  (2 * m / SPEED_OF_SOUND) * sampleRate;
