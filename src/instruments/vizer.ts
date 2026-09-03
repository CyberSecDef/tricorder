/**
 * Vizer — the colours actually present in the scene, laid out as a spectrum.
 *
 * Every pixel is binned by hue, the bins are ordered red to violet, and the
 * height of each band is how much of that colour the camera can see. A blue
 * room lights up the blue end and leaves the red end dark.
 *
 * ⚠️ It is a colour distribution, not a spectrogram, and the difference is
 * worth stating rather than glossing. A camera has three broad, overlapping
 * channels; infinitely many spectral power distributions produce identical
 * RGB. Nothing here can tell monochromatic yellow light from red and green
 * mixed, because the sensor cannot either — and neither can your eye. The
 * wavelength labels are an approximate convention that makes the axis legible,
 * not a measurement, and the UI says so.
 *
 * There is also no Fourier transform in here, deliberately. An FFT of an image
 * yields spatial frequencies — texture and edges — which is a genuinely
 * different quantity and would tell you nothing about colour. Binning by hue
 * is the operation that answers the question.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, escapeHtml } from '../ui/dom';
import { acquireCamera, CameraUnavailableError, type CameraHandle } from '../sensors/camera';
import {
  hueDistribution, binHue, hueToWavelength, binColor, BINS, HUE_SPAN,
  type HueDistribution,
} from '../lib/huespectrum';
import { theme } from '../ui/theme';

/** Sampling resolution. 160x120 is 19 200 pixels — ample, and cheap. */
const SAMPLE_W = 160;
/** Analysis rate, Hz. The eye cannot read a histogram faster than this. */
const RATE_HZ = 15;
/** Smoothing across frames, so the bars breathe rather than flicker. */
const SMOOTH = 0.25;
/** Peak-hold decay per second. Slow, so "what have I seen" stays legible. */
const HOLD_DECAY = 0.12;

export class VizerInstrument extends Instrument {
  readonly id = 'vizer';
  readonly title = 'Vizer';
  override readonly subtitle = 'Colours present in the scene';
  override readonly resources = 'camera';

  private cam: CameraHandle | null = null;
  private work = document.createElement('canvas');
  private smoothed = new Float32Array(BINS);
  private hold = new Float32Array(BINS);
  private dist: HueDistribution | null = null;
  private holdOn = true;
  private lastSample = 0;

  protected async build(root: HTMLElement): Promise<void> {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);
    const statusBox = el('div');
    append(scroll, statusBox);

    try {
      this.cam = await acquireCamera();
    } catch (e) {
      append(statusBox, notice('bad', cameraErrorHtml(e as CameraUnavailableError)));
      return;
    }
    if (!this.isMounted) { this.cam.release(); return; }
    this.onCleanup(() => this.cam?.release());

    const video = this.cam.video;
    video.className = 'vizer__video';
    append(scroll, el('div', { class: 'vizer__preview' }, video));

    this.work.width = SAMPLE_W;

    // --- the spectrum -----------------------------------------------------
    const spec = autoCanvas();
    const specBox = el('div', { class: 'scope', style: 'height:min(38dvh,320px)' }, spec.node);
    const specCap = el('div', { class: 'scope__cap', text: '' });
    append(specBox, specCap);
    append(scroll, section('Spectrum — red to violet'), specBox);

    // --- readouts ---------------------------------------------------------
    const rDominant = readout('Dominant colour', { note: '', wide: true });
    const rSat = readout('Mean saturation', { unit: '%', note: 'of the coloured pixels' });
    const rGrey = readout('Achromatic', { unit: '%', note: 'too grey or dark to have a hue' });
    const rPurple = readout('Non-spectral', { unit: '%', note: 'magentas — no single wavelength' });

    append(scroll, rDominant.node,
      el('div', { class: 'grid' }, rSat.node, rGrey.node, rPurple.node));

    const btnHold = el('button', { class: 'btn', type: 'button' }, 'Peak hold: on');
    btnHold.addEventListener('click', () => {
      this.holdOn = !this.holdOn;
      btnHold.textContent = `Peak hold: ${this.holdOn ? 'on' : 'off'}`;
      if (!this.holdOn) this.hold.fill(0);
    });
    const btnClear = el('button', { class: 'btn btn--alt', type: 'button' }, 'Clear hold');
    btnClear.addEventListener('click', () => this.hold.fill(0));
    append(scroll, el('div', { class: 'btn-row' }, btnHold, btnClear));

    append(scroll, notice('warn',
      '<strong>This is a colour distribution, not a spectrometer.</strong> A camera has three broad, overlapping channels, so infinitely many different light spectra produce identical RGB. It cannot tell monochromatic yellow from red and green mixed — and neither can your eye, which is why screens work at all. ' +
      'The nanometre labels are an approximate convention that makes the axis readable, not a measurement.'),
      notice('warn',
      '<strong>Magentas are counted separately, and that is not a technicality.</strong> There is no wavelength that produces magenta: it is what you see when your long and short cones fire without the middle one. Putting it on a wavelength axis would be inventing a physical claim, so it gets its own readout instead.'));

    // --- loop -------------------------------------------------------------
    this.loop(() => {
      spec.resize();
      const now = performance.now();
      if (now - this.lastSample >= 1000 / RATE_HZ) {
        this.lastSample = now;
        this.sample();
      }

      const d = this.dist;
      if (d && d.peakBin >= 0) {
        const hue = binHue(d.peakBin);
        rDominant.set(colorName(hue),
          `hue ${fmt(hue, 0)}° · approximately ${fmt(hueToWavelength(hue), 0)} nm`);
        rDominant.setState('ok');
      } else {
        rDominant.set('—', d ? 'nothing colourful enough in view' : 'starting camera');
        rDominant.setState('idle');
      }
      rSat.set(d ? fmt(d.meanSaturation * 100, 0) : '—');
      rGrey.set(d ? fmt(d.achromatic * 100, 0) : '—',
        d && d.achromatic > 0.9 ? 'the scene is essentially grey' : 'too grey or dark to have a hue');
      rGrey.setState(!d ? 'idle' : d.achromatic > 0.9 ? 'warn' : 'ok');
      rPurple.set(d ? fmt(d.nonSpectral * 100, 0) : '—');
      rPurple.setState(!d ? 'idle' : d.nonSpectral > 0.05 ? 'warn' : 'idle');

      specCap.textContent = `${BINS} BANDS · 700–405 NM APPROX`;
      this.draw(spec);
    });
  }

  private sample(): void {
    const cam = this.cam;
    if (!cam) return;
    const video = cam.video;
    if (!video.videoWidth) return;

    const h = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * SAMPLE_W));
    if (this.work.height !== h) this.work.height = h;
    const ctx = this.work.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0, SAMPLE_W, h);
    const img = ctx.getImageData(0, 0, SAMPLE_W, h);

    const d = hueDistribution(img.data);
    this.dist = d;

    for (let i = 0; i < BINS; i++) {
      this.smoothed[i] += (d.bins[i] - this.smoothed[i]) * SMOOTH;
      if (this.holdOn) {
        this.hold[i] = Math.max(this.hold[i] - HOLD_DECAY / RATE_HZ, this.smoothed[i]);
      }
    }
  }

  /**
   * Bars over a reference gradient.
   *
   * The gradient underneath shows the whole spectrum at low brightness, so an
   * absent colour reads as a dark gap rather than as nothing at all — which is
   * the entire point of the instrument. Without it you cannot tell "no red in
   * the room" from "the red end of the axis is off screen".
   */
  private draw(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const floor = h - 18;
    const barW = w / BINS;

    // Reference gradient: what the full spectrum would look like.
    for (let i = 0; i < BINS; i++) {
      ctx.fillStyle = binColor(i, 1);
      ctx.globalAlpha = 0.13;
      ctx.fillRect(i * barW, 0, barW + 0.5, floor);
    }
    ctx.globalAlpha = 1;

    // Peak hold behind the live bars.
    if (this.holdOn) {
      for (let i = 0; i < BINS; i++) {
        const bh = this.hold[i] * (floor - 6);
        if (bh <= 0.5) continue;
        ctx.fillStyle = binColor(i, 1);
        ctx.globalAlpha = 0.3;
        ctx.fillRect(i * barW, floor - bh, Math.max(barW - 0.5, 1), bh);
      }
      ctx.globalAlpha = 1;
    }

    // Live bars.
    for (let i = 0; i < BINS; i++) {
      const v = this.smoothed[i];
      const bh = v * (floor - 6);
      if (bh <= 0.5) continue;
      ctx.fillStyle = binColor(i, 1);
      ctx.fillRect(i * barW, floor - bh, Math.max(barW - 0.5, 1), bh);
    }

    // Wavelength axis.
    ctx.font = '9px ui-monospace, monospace';
    ctx.fillStyle = col.dimmer;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.strokeStyle = col.grid;
    for (const nm of [700, 620, 580, 530, 490, 460, 420]) {
      const hue = wavelengthToHue(nm);
      const x = (hue / HUE_SPAN) * w;
      ctx.beginPath(); ctx.moveTo(x, floor); ctx.lineTo(x, floor + 3); ctx.stroke();
      ctx.fillText(String(nm), Math.min(Math.max(x, 14), w - 14), floor + 5);
    }
  }
}

/** Inverse of hueToWavelength, for placing the axis ticks. */
function wavelengthToHue(nm: number): number {
  let lo = 0, hi = HUE_SPAN;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (hueToWavelength(mid) > nm) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function colorName(hue: number): string {
  const names: Array<[number, string]> = [
    [12, 'RED'], [38, 'ORANGE'], [70, 'YELLOW'], [95, 'YELLOW-GREEN'],
    [145, 'GREEN'], [175, 'SPRING GREEN'], [195, 'CYAN'], [220, 'AZURE'],
    [250, 'BLUE'], [280, 'VIOLET'],
  ];
  for (const [limit, name] of names) if (hue <= limit) return name;
  return 'VIOLET';
}

function cameraErrorHtml(err: CameraUnavailableError): string {
  const base = `<strong>Camera unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base + ' Check the site\'s camera permission, and that Settings &rarr; Privacy &amp; Security &rarr; Camera allows the browser itself.';
  }
  return base;
}
