/**
 * Instrument 4 — Seismograph / vibration (§8.4).
 *
 * Uses `e.acceleration`, which on iOS genuinely has gravity removed by Core
 * Motion. High-passed at ~0.5 Hz to kill residual drift, then rendered as a
 * scrolling waveform with a rolling RMS and a 4 s FFT.
 *
 * The amplitude is an ARBITRARY INDEX. It is not Richter, it is not a
 * seismometer, and the UI says so — a phone accelerometer has neither the
 * noise floor nor the calibration for a magnitude scale.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice } from '../ui/dom';
import { motion } from '../sensors/motion';
import { HighPass, RingBuffer, magnitudeSpectrum, hann, parabolicPeak, rms } from '../lib/dsp';
import { len } from '../lib/vec';
import { theme } from '../ui/theme';

/** ~60 Hz × 4 s, rounded to a power of two for the FFT. */
const FFT_N = 256;
/** Scrolling trace history — about 12 s at 60 Hz. */
const TRACE_N = 720;
/** Rolling RMS window, ~1 s. */
const RMS_N = 64;

export class SeismographInstrument extends Instrument {
  readonly id = 'seismo';
  readonly title = 'Seismograph';
  override readonly subtitle = 'Vibration · relative index';
  override readonly resources = 'motion';

  private hpX = new HighPass(0.5);
  private hpY = new HighPass(0.5);
  private hpZ = new HighPass(0.5);

  private trace = new RingBuffer(TRACE_N);
  private traceX = new RingBuffer(TRACE_N);
  private traceY = new RingBuffer(TRACE_N);
  private traceZ = new RingBuffer(TRACE_N);
  private fftBuf = new RingBuffer(FFT_N);
  private rmsBuf = new RingBuffer(RMS_N);

  private peak = 0;
  /** Exponential decay time constant for peak hold, seconds. */
  private static readonly PEAK_TAU = 4;
  private sampleRate = 0;
  private dtEMA = 0;
  private noSensor = true;
  private scratch = new Float32Array(FFT_N);
  private drawX = new Float32Array(TRACE_N);
  private drawY = new Float32Array(TRACE_N);
  private drawZ = new Float32Array(TRACE_N);
  private drawM = new Float32Array(TRACE_N);
  private spectrum: Float32Array = new Float32Array(FFT_N / 2);
  private dominantHz = 0;
  private dominantMag = 0;

  protected build(root: HTMLElement): void {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    const warnBox = el('div');
    append(scroll, warnBox);

    // --- Scrolling trace --------------------------------------------------
    const wave = autoCanvas();
    const waveBox = el('div', { class: 'scope', style: 'height:min(30dvh,240px)' }, wave.node);
    const waveCap = el('div', { class: 'scope__cap', text: '' });
    append(waveBox, waveCap);
    append(scroll, section('Waveform'), waveBox);

    const rNow = readout('Amplitude', { unit: 'idx', note: 'high-passed |a|, arbitrary index' });
    const rRms = readout('RMS (1 s)', { unit: 'idx', note: '' });
    const rPeak = readout('Peak hold', { unit: 'idx', note: 'exponential decay, τ = 4 s' });
    const rRate = readout('Sample rate', { unit: 'Hz', note: 'from e.interval' });

    append(scroll, el('div', { class: 'grid' }, rNow.node, rRms.node, rPeak.node, rRate.node));

    // --- Spectrum ---------------------------------------------------------
    const spec = autoCanvas();
    const specBox = el('div', { class: 'scope', style: 'height:min(26dvh,200px)' }, spec.node);
    const specCap = el('div', { class: 'scope__cap', text: '' });
    append(specBox, specCap);

    const rDom = readout('Dominant frequency', { unit: 'Hz', note: '' });
    const rBin = readout('Bin width', { unit: 'Hz', note: `${FFT_N}-point FFT` });

    append(
      scroll,
      section('Spectrum'),
      specBox,
      el('div', { class: 'grid' }, rDom.node, rBin.node),
      notice(
        'warn',
        '<strong>This is not a Richter scale.</strong> The amplitude is an arbitrary index derived from a consumer accelerometer with no calibration and no seismic noise floor. It is good for comparing events to each other on this device, and for nothing else. Useful spectrum ceiling is about 30 Hz — half the ~60 Hz sample rate.',
      ),
    );

    // --- Stream -----------------------------------------------------------
    this.sub(motion, (m) => {
      this.dtEMA = this.dtEMA === 0 ? m.dt : this.dtEMA + (m.dt - this.dtEMA) * 0.05;
      this.sampleRate = this.dtEMA > 0 ? 1 / this.dtEMA : 0;

      // Prefer gravity-removed acceleration; fall back only if absent.
      const a = m.accel;
      if (!a) return;
      this.noSensor = false;

      const x = this.hpX.process(a.x, m.dt);
      const y = this.hpY.process(a.y, m.dt);
      const z = this.hpZ.process(a.z, m.dt);
      const mag = len({ x, y, z });

      this.traceX.push(x); this.traceY.push(y); this.traceZ.push(z);
      this.trace.push(mag);
      this.fftBuf.push(mag);
      this.rmsBuf.push(mag);

      if (mag > this.peak) this.peak = mag;
    });

    // Recompute the spectrum a few times a second, not every frame — the
    // input only advances at ~60 Hz and the FFT is the expensive part.
    this.every(250, () => this.computeSpectrum());

    // --- Render -----------------------------------------------------------
    this.loop((dt) => {
      wave.resize();
      spec.resize();

      // Exponential, not linear: a fixed per-second subtraction zeroes the
      // peak instantly whenever the signal is small, which is most of the time.
      this.peak *= Math.exp(-dt / SeismographInstrument.PEAK_TAU);

      if (this.noSensor && warnBox.childElementCount === 0) {
        append(warnBox, notice('bad',
          '<strong>No acceleration data.</strong> DeviceMotion is not delivering a gravity-removed vector. Check the motion permission was granted, and that Settings → Safari → Motion &amp; Orientation Access is on.'));
      }

      const now = this.trace.length ? this.trace.toArray()[this.trace.length - 1] : 0;
      const r = rms(this.rmsBuf.toArray());

      rNow.set(fmt(now, 4));
      rNow.setState(now > 0.5 ? 'bad' : now > 0.08 ? 'warn' : 'ok');
      rRms.set(fmt(r, 4));
      rRms.setState(r > 0.2 ? 'warn' : 'ok');
      rPeak.set(fmt(this.peak, 4));
      rRate.set(this.sampleRate ? fmt(this.sampleRate, 1) : '—',
        this.dtEMA ? `dt ≈ ${fmt(this.dtEMA * 1000, 2)} ms` : 'awaiting samples');
      rRate.setState(this.sampleRate > 45 ? 'ok' : this.sampleRate > 0 ? 'warn' : 'idle');

      const nyquist = this.sampleRate / 2;
      const binHz = this.sampleRate / FFT_N;
      rBin.set(binHz ? fmt(binHz, 3) : '—', `${FFT_N}-pt FFT · ceiling ${nyquist ? fmt(nyquist, 1) : '—'} Hz`);
      rDom.set(this.dominantMag > 1e-5 ? fmt(this.dominantHz, 2) : '—',
        this.dominantMag > 1e-5 ? `magnitude ${fmt(this.dominantMag, 5)}` : 'below noise floor');
      rDom.setState(this.dominantMag > 1e-5 ? 'ok' : 'idle');

      waveCap.textContent = `±${fmt(this.waveScale(), 3)} IDX F.S. · ${fmt(TRACE_N / Math.max(this.sampleRate, 1), 1)} S SPAN`;
      specCap.textContent = `0–${fmt(nyquist, 0)} HZ`;

      this.drawWave(wave);
      this.drawSpectrum(spec, binHz, nyquist);
    });
  }

  private computeSpectrum(): void {
    if (this.fftBuf.length < FFT_N) return;
    const w = hann(FFT_N);
    this.fftBuf.tail(FFT_N, this.scratch);
    // Remove the window mean before transforming, so a DC offset the
    // high-pass has not fully settled out does not dominate bin 0.
    let mean = 0;
    for (let i = 0; i < FFT_N; i++) mean += this.scratch[i];
    mean /= FFT_N;
    for (let i = 0; i < FFT_N; i++) this.scratch[i] = (this.scratch[i] - mean) * w[i];

    this.spectrum = magnitudeSpectrum(this.scratch);

    // Skip bin 0 and 1 — residual DC and the high-pass corner live there.
    let best = 2;
    for (let i = 2; i < this.spectrum.length; i++) {
      if (this.spectrum[i] > this.spectrum[best]) best = i;
    }
    const binHz = this.sampleRate / FFT_N;
    this.dominantHz = (best + parabolicPeak(this.spectrum, best)) * binHz;
    this.dominantMag = this.spectrum[best];
  }

  /** Auto-ranging full-scale value, quantised so the axis does not jitter. */
  private waveScale(): number {
    const data = this.trace.toArray();
    let max = 0.02;
    for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]));
    const exp = Math.ceil(Math.log2(max / 0.02));
    return 0.02 * Math.pow(2, Math.max(0, exp));
  }

  private drawWave(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const scale = this.waveScale();
    const mid = h / 2;

    ctx.strokeStyle = col.grid;
    ctx.lineWidth = 1;
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const y = mid - f * (h / 2 - 4);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    // tail() zero-pads at the front, so the newest sample always lands on the
    // right edge and the trace scrolls leftwards like a real chart recorder.
    const plotTrace = (buf: RingBuffer, scratch: Float32Array, colour: string, width: number, alpha: number) => {
      const d = buf.tail(TRACE_N, scratch);
      ctx.beginPath();
      for (let i = 0; i < TRACE_N; i++) {
        const x = (i / (TRACE_N - 1)) * w;
        const y = mid - (d[i] / scale) * (h / 2 - 4);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = colour;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    plotTrace(this.traceX, this.drawX, col.trace[2], 1, 0.62);
    plotTrace(this.traceY, this.drawY, col.trace[1], 1, 0.62);
    plotTrace(this.traceZ, this.drawZ, col.trace[3], 1, 0.62);
    plotTrace(this.trace, this.drawM, col.trace[0], 1.6, 1);

    // Bottom-left: the top-right corner belongs to .scope__cap.
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    let lx = 8;
    for (const [label, colour] of [['X', col.trace[2]], ['Y', col.trace[1]], ['Z', col.trace[3]], ['|a|', col.trace[0]]] as const) {
      ctx.fillStyle = colour;
      ctx.fillText(`▬ ${label}`, lx, h - 5);
      lx += ctx.measureText(`▬ ${label}`).width + 9;
    }
  }

  private drawSpectrum(c: ReturnType<typeof autoCanvas>, binHz: number, nyquist: number): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h || !binHz) return;
    ctx.clearRect(0, 0, w, h);

    const bins = this.spectrum.length;
    let max = 1e-6;
    for (let i = 2; i < bins; i++) max = Math.max(max, this.spectrum[i]);

    const barW = w / (bins - 2);
    for (let i = 2; i < bins; i++) {
      const v = this.spectrum[i] / max;
      const bh = v * (h - 18);
      const x = (i - 2) * barW;
      ctx.fillStyle = i === Math.round(this.dominantHz / binHz) ? col.frame : col.dark1;
      ctx.fillRect(x, h - 14 - bh, Math.max(barW - 0.5, 0.8), bh);
    }

    // Frequency axis
    ctx.strokeStyle = col.grid;
    ctx.fillStyle = col.dim;
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = nyquist > 25 ? 5 : 2;
    for (let f = 0; f <= nyquist; f += step) {
      const x = (f / nyquist) * w;
      ctx.beginPath(); ctx.moveTo(x, h - 14); ctx.lineTo(x, h - 11); ctx.stroke();
      ctx.fillText(String(f), x, h - 10);
    }
  }
}
