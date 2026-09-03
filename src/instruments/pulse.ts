/**
 * Pulse rate — optical, from the fingertip.
 *
 * Press a fingertip over the rear camera with the torch lit. Each heartbeat
 * pushes blood through the tissue, which absorbs slightly more light, and the
 * camera sees a periodic dip of around 1% in brightness. Band-pass it, take
 * the spectrum, and the peak is the pulse. This is photoplethysmography, and
 * it is the same physical principle a pulse oximeter uses.
 *
 * WHAT THIS IS NOT, and the boundary matters more here than anywhere else in
 * the project, because "medical" invites a credulity that "seismograph" does
 * not:
 *
 *   - It is **not a medical device** and must not be used as one.
 *   - It does **not measure blood oxygen**. SpO2 requires two calibrated
 *     wavelengths and a known optical path; a camera has neither, and any app
 *     claiming it from a single RGB sensor is guessing.
 *   - It does **not measure blood pressure**. Nothing in this signal contains
 *     it.
 *   - It does **not detect arrhythmia** or any other abnormality. It reports
 *     one number, the dominant rate over the last seventeen seconds, and an
 *     irregular rhythm makes that number less meaningful rather than more.
 *
 * What it does measure, it measures honestly: a rate, with a confidence, and
 * it refuses to report when the signal will not support one.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireCamera, CameraUnavailableError, type CameraHandle } from '../sensors/camera';
import { RingBuffer } from '../lib/dsp';
import { estimateRate, BandPass, MIN_HZ, MAX_HZ, type RateEstimate } from '../lib/pulse';
import { theme } from '../ui/theme';

/** Sampling rate, Hz. Comfortably above the camera's ~30 fps ceiling is pointless. */
const SAMPLE_HZ = 30;
/** 512 samples at 30 Hz is a ~17 s window: 3.5 bpm per bin before interpolation. */
const WINDOW = 512;
/** Report nothing until this many samples exist. */
const MIN_SAMPLES = 256;
/** Spectral peak prominence required. Synthetic noise scores ~2; a pulse, 25+. */
const MIN_CONFIDENCE = 8;
/** Pixels sampled per axis from the centre of the frame. */
const PATCH = 48;

export class PulseInstrument extends Instrument {
  readonly id = 'pulse';
  readonly title = 'Pulse';
  override readonly subtitle = 'Optical, from the fingertip — not a medical device';
  override readonly resources = 'camera + torch';

  private cam: CameraHandle | null = null;
  private work = document.createElement('canvas');
  private band = new BandPass();
  private buf = new RingBuffer(WINDOW);
  private running = false;
  private torchOn = false;

  private meanR = 0;
  private meanG = 0;
  private meanB = 0;
  private spatialSd = 0;
  private fingerOn = false;
  private lastSampleAt = 0;
  private effectiveHz = SAMPLE_HZ;
  private est: RateEstimate | null = null;
  private bpmSmooth: number | null = null;

  protected async build(root: HTMLElement): Promise<void> {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);
    const statusBox = el('div');

    append(scroll,
      notice('bad',
        '<strong>This is not a medical device.</strong> It reports a pulse rate, and only that. ' +
        'It cannot measure blood oxygen — that needs two calibrated wavelengths and a known optical path, which a camera does not have. It cannot measure blood pressure. It cannot detect an irregular rhythm, and an irregular rhythm makes its single number less meaningful rather than more. ' +
        'Do not use it for anything that matters medically.'),
      statusBox);

    try {
      this.cam = await acquireCamera();
    } catch (e) {
      append(statusBox, notice('bad', cameraErrorHtml(e as CameraUnavailableError)));
      return;
    }
    if (!this.isMounted) { this.cam.release(); return; }
    this.onCleanup(() => { this.running = false; void this.setTorch(false); this.cam?.release(); });

    this.work.width = PATCH;
    this.work.height = PATCH;

    if (!this.cam.torch) {
      append(statusBox, notice('warn',
        '<strong>No torch on this camera.</strong> The measurement relies on the torch shining through the fingertip, so without it you will need very strong ambient light behind your finger and the signal will be poor.'));
    }

    // --- controls ---------------------------------------------------------
    const btnStart = el('button', { class: 'btn', type: 'button' }, 'Start');
    btnStart.addEventListener('click', async () => {
      if (this.running) { await this.stop(btnStart); } else { await this.start(btnStart); }
    });
    append(scroll, section('Measurement'), el('div', { class: 'btn-row' }, btnStart));

    // --- readouts ---------------------------------------------------------
    const rBpm = readout('Pulse', { unit: 'bpm', note: '', wide: true });
    const rConf = readout('Confidence', { unit: '×', note: 'spectral peak over band median' });
    const rFill = readout('Window', { unit: 's', note: '' });
    const rSignal = readout('Finger', { note: '' });

    append(scroll, rBpm.node,
      el('div', { class: 'grid' }, rConf.node, rFill.node, rSignal.node));

    const wave = autoCanvas();
    const waveBox = el('div', { class: 'scope', style: 'height:min(24dvh,180px)' }, wave.node);
    append(waveBox, el('div', { class: 'scope__cap', text: 'PLETHYSMOGRAM' }));

    const spec = autoCanvas();
    const specBox = el('div', { class: 'scope', style: 'height:min(20dvh,150px)' }, spec.node);
    const specCap = el('div', { class: 'scope__cap', text: '' });
    append(specBox, specCap);

    append(scroll, waveBox, specBox);

    append(scroll, notice('warn',
      '<strong>How to get a reading.</strong> Cover the rear camera <em>and</em> the torch completely with the pad of one fingertip. Rest it there — pressing hard squeezes the blood out and flattens the signal. Keep still; the pulse is about a 1% change in brightness and a moving finger swamps it entirely. ' +
      `It needs about ${Math.round(WINDOW / SAMPLE_HZ)} seconds of steady contact, and it will say so until it has them.`));

    // --- sampling ---------------------------------------------------------
    // On its own timer rather than the render loop, so the sample rate stays
    // even. A jittery series would smear the spectral peak that the whole
    // estimate depends on.
    this.every(Math.round(1000 / SAMPLE_HZ), () => this.sample());

    // --- render -----------------------------------------------------------
    let lastState = '';
    this.loop(() => {
      wave.resize();
      spec.resize();

      const filled = this.buf.length;
      const state = !this.running ? 'idle'
        : !this.fingerOn ? 'nofinger'
        : filled < MIN_SAMPLES ? 'filling'
        : 'ready';

      if (state !== lastState) {
        lastState = state;
        clear(statusBox);
        if (state === 'idle') {
          append(statusBox, notice('warn', '<strong>Not running.</strong> Press Start; the torch will come on.'));
        } else if (state === 'nofinger') {
          append(statusBox, notice('bad',
            '<strong>No finger detected.</strong> The camera is not seeing what a fingertip pressed against it looks like — bright, deep red and evenly lit. Cover both the lens and the torch completely.'));
        } else if (state === 'filling') {
          append(statusBox, notice('warn', '<strong>Collecting.</strong> Hold still.'));
        }
      }

      const ready = state === 'ready' && this.est && this.est.confidence >= MIN_CONFIDENCE;
      if (ready && this.est) {
        // Light smoothing across estimates. The underlying rate genuinely does
        // vary beat to beat, but a readout that jitters by several bpm reads as
        // unreliable even when each estimate is sound.
        this.bpmSmooth = this.bpmSmooth === null
          ? this.est.bpm
          : this.bpmSmooth + (this.est.bpm - this.bpmSmooth) * 0.25;
        rBpm.set(fmt(this.bpmSmooth, 0),
          `±${fmt((this.effectiveHz / WINDOW) * 60 / 2, 1)} bpm resolution · ${fmt(this.est.bpm, 1)} instantaneous`);
        rBpm.setState('ok');
      } else {
        this.bpmSmooth = null;
        rBpm.set('—',
          state === 'idle' ? 'press Start'
            : state === 'nofinger' ? 'cover the lens and torch'
            : state === 'filling' ? `collecting — ${fmt(filled / this.effectiveHz, 0)} of ${Math.round(WINDOW / SAMPLE_HZ)} s`
            : `signal too weak — confidence ${this.est ? fmt(this.est.confidence, 1) : '0'}× of the ${MIN_CONFIDENCE}× needed`);
        rBpm.setState('idle');
      }

      rConf.set(this.est ? fmt(this.est.confidence, 1) : '—',
        this.est ? (this.est.confidence >= MIN_CONFIDENCE ? 'clear peak' : 'no clear peak') : '');
      rConf.setState(!this.est ? 'idle' : this.est.confidence >= MIN_CONFIDENCE ? 'ok' : 'warn');
      rFill.set(fmt(filled / this.effectiveHz, 1), `${filled}/${WINDOW} samples @ ${fmt(this.effectiveHz, 1)} Hz`);
      rFill.setState(filled >= MIN_SAMPLES ? 'ok' : 'warn');
      rSignal.set(this.fingerOn ? 'DETECTED' : this.running ? 'ABSENT' : '—',
        `R ${fmt(this.meanR, 0)} G ${fmt(this.meanG, 0)} B ${fmt(this.meanB, 0)} · sd ${fmt(this.spatialSd, 0)}`);
      rSignal.setState(this.fingerOn ? 'ok' : this.running ? 'bad' : 'idle');

      specCap.textContent = `${Math.round(MIN_HZ * 60)}–${Math.round(MAX_HZ * 60)} BPM`;
      this.drawWave(wave);
      this.drawSpectrum(spec);
    });
  }

  private async start(btn: HTMLButtonElement): Promise<void> {
    this.buf.clear();
    this.band.reset();
    this.est = null;
    this.bpmSmooth = null;
    this.running = true;
    btn.textContent = 'Stop';
    btn.className = 'btn btn--warn';
    await this.setTorch(true);
  }

  private async stop(btn: HTMLButtonElement): Promise<void> {
    this.running = false;
    btn.textContent = 'Start';
    btn.className = 'btn';
    await this.setTorch(false);
  }

  private async setTorch(on: boolean): Promise<void> {
    if (!this.cam?.torch || this.torchOn === on) return;
    try { await this.cam.torch(on); this.torchOn = on; } catch { /* absent or refused */ }
  }

  /** One brightness sample from the centre of the frame. */
  private sample(): void {
    const cam = this.cam;
    if (!this.running || !cam) return;
    const video = cam.video;
    if (!video.videoWidth) return;

    const now = performance.now();
    const dt = this.lastSampleAt ? (now - this.lastSampleAt) / 1000 : 1 / SAMPLE_HZ;
    this.lastSampleAt = now;
    // Track the rate actually achieved — the timer will not hit 30 Hz exactly,
    // and the frequency axis is only as good as this number.
    this.effectiveHz = this.effectiveHz + (1 / Math.max(dt, 1e-3) - this.effectiveHz) * 0.05;

    const ctx = this.work.getContext('2d', { willReadFrequently: true })!;
    // Centre crop: the edges of the frame catch stray light around the finger.
    const side = Math.min(video.videoWidth, video.videoHeight) * 0.4;
    ctx.drawImage(video,
      (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side,
      0, 0, PATCH, PATCH);
    const d = ctx.getImageData(0, 0, PATCH, PATCH).data;

    let r = 0, g = 0, b = 0, lum = 0, lum2 = 0;
    const n = PATCH * PATCH;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]; g += d[i + 1]; b += d[i + 2];
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lum += l; lum2 += l * l;
    }
    this.meanR = r / n; this.meanG = g / n; this.meanB = b / n;
    const lm = lum / n;
    this.spatialSd = Math.sqrt(Math.max(0, lum2 / n - lm * lm));

    // A fingertip over a lit torch looks unmistakable: bright, overwhelmingly
    // red, and almost perfectly flat because the tissue diffuses everything.
    // Anything else in front of the camera fails at least one of the three.
    const redness = this.meanR / (this.meanG + this.meanB + 1);
    this.fingerOn = this.meanR > 40 && redness > 1.1 && this.spatialSd < 45;

    if (!this.fingerOn) { this.buf.clear(); this.band.reset(); this.est = null; return; }

    // Red carries the strongest pulsatile component in transmission through
    // tissue; green is better for reflective PPG off the wrist, which is not
    // what this is.
    this.buf.push(this.band.process(this.meanR, dt));

    if (this.buf.length >= MIN_SAMPLES) {
      this.est = estimateRate(this.buf.toArray(), this.effectiveHz);
    }
  }

  private drawWave(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const d = this.buf.toArray();
    if (d.length < 8) {
      ctx.fillStyle = col.gridMid;
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(this.running ? 'WAITING FOR A FINGER' : 'NOT RUNNING', w / 2, h / 2);
      return;
    }
    let max = 1e-6;
    for (let i = 0; i < d.length; i++) max = Math.max(max, Math.abs(d[i]));
    const mid = h / 2;
    ctx.strokeStyle = col.grid;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = (i / (WINDOW - 1)) * w;
      const y = mid - (d[i] / max) * (h / 2 - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = col.trace[0];
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  private drawSpectrum(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    const e = this.est;
    if (!e) return;

    const sp = e.spectrum;
    let max = 1e-12;
    for (let i = 0; i < sp.length; i++) max = Math.max(max, sp[i]);
    const barW = w / sp.length;
    for (let i = 0; i < sp.length; i++) {
      const bh = (sp[i] / max) * (h - 18);
      ctx.fillStyle = i === e.peakBin ? col.active : col.dark1;
      ctx.fillRect(i * barW, h - 14 - bh, Math.max(barW - 0.5, 1), bh);
    }
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = col.dimmer;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const bpm of [60, 90, 120, 150, 180]) {
      const hz = bpm / 60;
      const frac = (hz - MIN_HZ) / (MAX_HZ - MIN_HZ);
      if (frac < 0 || frac > 1) continue;
      ctx.fillText(String(bpm), frac * w, h - 11);
    }
  }
}

function cameraErrorHtml(err: CameraUnavailableError): string {
  const base = `<strong>Camera unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base + ' Check the site\'s camera permission, and that Settings &rarr; Privacy &amp; Security &rarr; Camera allows the browser itself.';
  }
  return base;
}
