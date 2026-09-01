/**
 * Pulse rate from a photoplethysmogram (PPG).
 *
 * With a fingertip pressed over the camera and the torch lit, each heartbeat
 * pushes a little more blood through the tissue, which absorbs a little more
 * light. The camera sees this as a periodic dip in brightness of roughly 1–2%
 * of the steady level. That is a real optical measurement of a real physical
 * event — but it is a *rate*, and nothing more. See the instrument for what
 * this deliberately does not claim.
 *
 * DOM-free so it can be tested against synthetic signals of known rate, which
 * is the only way to know an estimator works before pointing it at a person.
 */

import { fft, hann, parabolicPeak } from './dsp';

/** Plausible human range, Hz. 0.7–3.5 Hz is 42–210 BPM. */
export const MIN_HZ = 0.7;
export const MAX_HZ = 3.5;

export interface RateEstimate {
  bpm: number;
  /**
   * Prominence of the spectral peak over the median of the band, which is a
   * far better guide than amplitude: a strong but broad hump is motion, and a
   * narrow peak is a pulse.
   */
  confidence: number;
  /** Magnitude spectrum over the analysis band, for display. */
  spectrum: Float32Array;
  /** Hz per bin, so the UI can label the axis and state its own resolution. */
  binHz: number;
  /** Index into `spectrum` of the chosen peak. */
  peakBin: number;
}

/**
 * Estimate rate from a uniformly sampled brightness series.
 *
 * `samples` should already be detrended; this removes the residual mean and
 * windows before transforming. Returns null when the buffer is too short to
 * resolve the band at all.
 */
export function estimateRate(
  samples: Float32Array, sampleRate: number,
): RateEstimate | null {
  const n = prevPow2(samples.length);
  if (n < 64 || !(sampleRate > 0)) return null;

  const src = samples.subarray(samples.length - n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const w = hann(n);

  let mean = 0;
  for (let i = 0; i < n; i++) mean += src[i];
  mean /= n;
  for (let i = 0; i < n; i++) re[i] = (src[i] - mean) * w[i];

  fft(re, im);

  const binHz = sampleRate / n;
  const loBin = Math.max(1, Math.ceil(MIN_HZ / binHz));
  const hiBin = Math.min((n >> 1) - 1, Math.floor(MAX_HZ / binHz));
  if (hiBin <= loBin + 2) return null;

  const spectrum = new Float32Array(hiBin - loBin + 1);
  for (let i = loBin; i <= hiBin; i++) {
    spectrum[i - loBin] = Math.hypot(re[i], im[i]) / (n / 2);
  }

  // Strongest local maximum in the band. Requiring a local maximum matters:
  // without it the estimator happily returns the edge of the band whenever the
  // signal is dominated by drift the high-pass did not fully remove.
  let peak = -1, peakVal = -Infinity;
  for (let i = 1; i < spectrum.length - 1; i++) {
    if (spectrum[i] > peakVal && spectrum[i] >= spectrum[i - 1] && spectrum[i] >= spectrum[i + 1]) {
      peakVal = spectrum[i]; peak = i;
    }
  }
  if (peak < 0) return null;

  const med = median(spectrum);
  const confidence = med > 1e-12 ? peakVal / med : 0;

  // Sub-bin interpolation. At 30 Hz over 512 samples a bin is 3.5 BPM, which
  // would be a visibly coarse readout without this.
  const frac = parabolicPeak(spectrum, peak);
  const hz = (loBin + peak + frac) * binHz;

  return { bpm: hz * 60, confidence, spectrum, binHz, peakBin: peak };
}

/**
 * Band-pass a new sample, in place, via a pair of one-pole filters.
 *
 * The high-pass removes the large DC level and the slow drift from the finger
 * settling or the torch warming; the low-pass removes sensor noise well above
 * any plausible pulse. What survives is the pulsatile component, which is
 * around 1% of the signal that arrived.
 */
export class BandPass {
  private hpPrevIn = 0;
  private hpPrevOut = 0;
  private lpPrev = 0;
  private primed = false;

  constructor(private readonly hpHz = MIN_HZ * 0.7, private readonly lpHz = MAX_HZ * 1.6) {}

  process(x: number, dt: number): number {
    if (!this.primed) { this.hpPrevIn = x; this.hpPrevOut = 0; this.lpPrev = 0; this.primed = true; return 0; }
    const d = Math.max(dt, 1e-4);

    const rcH = 1 / (2 * Math.PI * this.hpHz);
    const aH = rcH / (rcH + d);
    const hp = aH * (this.hpPrevOut + x - this.hpPrevIn);
    this.hpPrevIn = x;
    this.hpPrevOut = hp;

    const rcL = 1 / (2 * Math.PI * this.lpHz);
    const aL = d / (rcL + d);
    this.lpPrev += aL * (hp - this.lpPrev);
    return this.lpPrev;
  }

  reset(): void { this.primed = false; }
}

function prevPow2(n: number): number {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
}

function median(a: ArrayLike<number>): number {
  const s = Array.from(a).sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
}
