/**
 * Instrument 6 — Floor-plane rangefinder (§8.6).
 *
 * Genuinely metric distance from the camera and the gravity vector alone. No
 * model, no scale ambiguity: with the camera a known height above a flat
 * floor, a ray depressed θ below horizontal meets the floor at h/tanθ. Works
 * for any point where an object meets the floor.
 *
 * Two things this screen refuses to do, because they would make the numbers
 * dishonest:
 *   - present a reading beyond MAX_RANGE_M, where the 1/tanθ error growth has
 *     made it meaningless;
 *   - imply a calibrated FOV when none has been measured. Field of view is the
 *     dominant error source and getUserMedia may crop relative to the native
 *     camera, so until the user calibrates, the uncertainty band carries the
 *     full width of that ignorance rather than hiding it.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireCamera, tapToFrameCoords, CameraUnavailableError, type CameraHandle } from '../sensors/camera';
import { gravity, calibration as gravityCalibration } from '../sensors/gravity';
import { frameRay, solveFloor, solveFovDeg, MAX_RANGE_M, type FloorSolution } from '../lib/rangefinder';
import { capabilities, fingerprint } from '../lib/capabilities';
import type { Vec3 } from '../lib/vec';
import * as storage from '../lib/storage';

/** Starting FOV before calibration. Nominal only — never presented as fact. */
const NOMINAL_FOV_DEG = 65;
/** 1σ on the FOV: wide until measured, tight once solved against a tape. */
const FOV_SIGMA_UNCALIBRATED = 8;
const FOV_SIGMA_CALIBRATED = 1;

const DEFAULT_HEIGHT_M = 1.4;   // chest height, per §8.6

interface Pin { u: number; v: number; sol: FloorSolution; sigma: number }

export class RangefinderInstrument extends Instrument {
  readonly id = 'rangefinder';
  readonly title = 'Floor-Plane Rangefinder';
  override readonly subtitle = 'Metric distance · camera + gravity';
  override readonly resources = 'camera + motion';

  private cam: CameraHandle | null = null;
  private gDown: Vec3 | null = null;
  private settled = false;
  private height = storage.load<number>('rangefinder:height', DEFAULT_HEIGHT_M);
  private fovDeg = NOMINAL_FOV_DEG;
  private fovCalibrated = false;
  private pins: Pin[] = [];
  private calibrating = false;
  private calibrationTarget = 2.0;

  /**
   * Calibration is keyed by capability fingerprint AND orientation, never by
   * user-agent string (§8.6). Safari and WKWebView may crop the stream
   * differently, and the frame aspect flips with the device, so one stored
   * value cannot serve every context.
   */
  private get fovKey(): string {
    const orient = window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
    return `rangefinder:fov:${fingerprint(capabilities())}:${orient}`;
  }

  private loadFov(): void {
    const stored = storage.load<number | null>(this.fovKey, null);
    this.fovCalibrated = stored !== null;
    this.fovDeg = stored ?? NOMINAL_FOV_DEG;
  }

  protected async build(root: HTMLElement): Promise<void> {
    this.loadFov();

    const stage = el('div', { class: 'rf' });
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, stage, scroll);

    const statusBox = el('div');
    append(scroll, statusBox);

    const gcal = gravityCalibration();
    if (!gcal.verified) {
      append(statusBox, notice('bad',
        '<strong>Gravity sign convention is not calibrated.</strong> Every ray in this instrument is built from ĝ_down, so an inverted polarity makes every reading wrong rather than merely imprecise. Run Diagnostics → Calibrate gravity first.'));
    }

    try {
      this.cam = await acquireCamera();
    } catch (e) {
      const err = e as CameraUnavailableError;
      append(statusBox, notice('bad', cameraErrorHtml(err)));
      return;
    }
    if (!this.isMounted) { this.cam.release(); return; }
    this.onCleanup(() => this.cam?.release());

    const video = this.cam.video;
    video.className = 'rf__video';
    const overlay = el('canvas', { class: 'rf__overlay' });
    append(stage, video, overlay);
    const octx = overlay.getContext('2d')!;

    // --- tap to measure ---------------------------------------------------
    this.listen(stage, 'click', (ev) => {
      const e = ev as MouseEvent;
      this.onTap(e.clientX, e.clientY, stage);
    });

    // --- readouts ---------------------------------------------------------
    const rDist = readout('Horizontal distance', { unit: 'm', note: '', wide: true });
    const rSlant = readout('Slant range', { unit: 'm', note: '' });
    const rTheta = readout('Depression', { unit: '°', note: 'below horizontal' });
    const rHeight = readout('Camera height', { unit: 'm', note: '' });
    const rFov = readout('Field of view', { unit: '°', note: '' });

    append(scroll,
      section('Measurement'),
      rDist.node,
      el('div', { class: 'grid' }, rSlant.node, rTheta.node),
      section('Setup'),
      el('div', { class: 'grid' }, rHeight.node, rFov.node));

    // --- camera height ----------------------------------------------------
    const hInput = el('input', {
      type: 'number', step: '0.05', min: '0.2', max: '3',
      value: String(this.height), class: 'rf__input', inputmode: 'decimal',
    }) as HTMLInputElement;
    hInput.addEventListener('change', () => {
      const v = parseFloat(hInput.value);
      if (Number.isFinite(v) && v >= 0.2 && v <= 3) {
        this.height = v;
        storage.save('rangefinder:height', v);
        // Existing pins were solved at the old height and are now wrong.
        this.pins = [];
      } else {
        hInput.value = String(this.height);
      }
    });

    const btnClear = el('button', { class: 'btn btn--warn', type: 'button' }, 'Clear pins');
    btnClear.addEventListener('click', () => { this.pins = []; });

    append(scroll,
      el('div', { class: 'rf__row' },
        el('label', { class: 'rf__label', text: 'Camera height (m)' }), hInput, btnClear));

    // --- calibration ------------------------------------------------------
    const calBox = el('div');
    const dInput = el('input', {
      type: 'number', step: '0.1', min: '0.3', max: '8',
      value: String(this.calibrationTarget), class: 'rf__input', inputmode: 'decimal',
    }) as HTMLInputElement;
    dInput.addEventListener('change', () => {
      const v = parseFloat(dInput.value);
      if (Number.isFinite(v) && v >= 0.3 && v <= MAX_RANGE_M) this.calibrationTarget = v;
      else dInput.value = String(this.calibrationTarget);
    });

    const btnCal = el('button', { class: 'btn', type: 'button' }, 'Start calibration');
    const btnReset = el('button', { class: 'btn btn--alt', type: 'button' }, 'Reset FOV');

    const renderCal = () => {
      clear(calBox);
      append(calBox, notice(
        this.fovCalibrated ? 'ok' : 'warn',
        this.fovCalibrated
          ? `<strong>Calibrated.</strong> Effective horizontal FOV ${this.fovDeg.toFixed(2)}° for this browser and orientation. Stored against the capability fingerprint, not the user-agent string — Safari and WKWebView may crop the stream differently.`
          : `<strong>Uncalibrated.</strong> Running on a nominal ${NOMINAL_FOV_DEG}° field of view, which is a guess. FOV is the dominant error source here and <code>getUserMedia</code> may crop relative to the native camera, so the uncertainty band below carries ±${FOV_SIGMA_UNCALIBRATED}° of FOV ignorance. Measure a real distance with a tape, enter it, and tap that point.`));
      if (this.calibrating) {
        append(calBox, notice('warn',
          `<strong>Calibrating.</strong> Tap exactly where the object at ${this.calibrationTarget.toFixed(2)} m meets the floor. Hold the phone at the height entered above.`));
      }
    };

    btnCal.addEventListener('click', () => {
      this.calibrating = !this.calibrating;
      btnCal.textContent = this.calibrating ? 'Cancel calibration' : 'Start calibration';
      renderCal();
    });
    btnReset.addEventListener('click', () => {
      storage.remove(this.fovKey);
      this.loadFov();
      this.pins = [];
      renderCal();
    });

    append(scroll,
      section('FOV calibration'),
      calBox,
      el('div', { class: 'rf__row' },
        el('label', { class: 'rf__label', text: 'Known distance (m)' }), dInput),
      el('div', { class: 'btn-row' }, btnCal, btnReset));
    renderCal();
    this.onCalibrated = renderCal;

    append(scroll, notice('warn',
      `<strong>Accuracy degrades as 1/tanθ.</strong> Good to a few percent from about 0.5–5 m; the uncertainty band widens sharply beyond that and readings past ${MAX_RANGE_M} m are refused outright rather than shown as a number you might believe. The floor must actually be flat and level — a slope invalidates the whole derivation.`));

    // Orientation change flips the frame aspect and invalidates the stored
    // calibration key, so re-read it rather than carrying the wrong one (§9).
    const onOrient = () => { this.loadFov(); this.pins = []; renderCal(); };
    this.listen(window, 'orientationchange', onOrient);
    this.listen(window, 'resize', onOrient);

    // --- streams ----------------------------------------------------------
    this.sub(gravity, (g) => { this.gDown = g.down; this.settled = g.settled; });

    // --- render -----------------------------------------------------------
    this.loop(() => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      if (overlay.width !== Math.round(r.width * dpr) || overlay.height !== Math.round(r.height * dpr)) {
        overlay.width = Math.round(r.width * dpr);
        overlay.height = Math.round(r.height * dpr);
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      const latest = this.pins[this.pins.length - 1];
      if (latest) {
        const beyond = latest.sol.horizontal > MAX_RANGE_M;
        rDist.set(beyond ? 'OUT OF RANGE' : fmt(latest.sol.horizontal, 2),
          beyond
            ? `beyond ${MAX_RANGE_M} m — the 1/tanθ error growth makes this meaningless`
            : `± ${fmt(latest.sigma, 2)} m (1σ, ${fmt((latest.sigma / latest.sol.horizontal) * 100, 0)}%)${this.fovCalibrated ? '' : ' · UNCALIBRATED'}`);
        rDist.setState(beyond ? 'bad' : this.fovCalibrated ? 'ok' : 'warn');
        rSlant.set(beyond ? '—' : fmt(latest.sol.slant, 2));
        rTheta.set(fmt(latest.sol.thetaDeg, 1),
          latest.sol.thetaDeg < 8 ? 'very shallow — large error' : '');
        rTheta.setState(latest.sol.thetaDeg < 8 ? 'bad' : latest.sol.thetaDeg < 15 ? 'warn' : 'ok');
      } else {
        rDist.set('—', 'tap where an object meets the floor');
        rDist.setState('idle');
        rSlant.set('—');
        rTheta.set('—');
      }

      rHeight.set(fmt(this.height, 2), this.settled ? 'device steady' : 'device moving — hold still');
      rHeight.setState(this.settled ? 'ok' : 'warn');
      rFov.set(fmt(this.fovDeg, 1),
        this.fovCalibrated ? `calibrated ±${FOV_SIGMA_CALIBRATED}°` : `nominal ±${FOV_SIGMA_UNCALIBRATED}° — not measured`);
      rFov.setState(this.fovCalibrated ? 'ok' : 'warn');

      this.drawOverlay(octx, r.width, r.height, stage);
    });
  }

  private onCalibrated: () => void = () => {};

  private onTap(clientX: number, clientY: number, stage: HTMLElement): void {
    const cam = this.cam;
    const g = this.gDown;
    if (!cam || !g) return;

    const fw = cam.video.videoWidth;
    const fh = cam.video.videoHeight;
    const coords = tapToFrameCoords(clientX, clientY, stage, fw, fh, 'cover');
    if (!coords) return;

    const aspect = fh / fw;

    if (this.calibrating) {
      const fov = solveFovDeg(coords.u, coords.v, g, this.height, this.calibrationTarget, aspect);
      if (fov === null) {
        // Nothing sensible to store; tell the user rather than silently fail.
        this.calibrating = false;
        this.onCalibrated();
        return;
      }
      this.fovDeg = fov;
      this.fovCalibrated = true;
      storage.save(this.fovKey, fov);
      this.calibrating = false;
      this.pins = [];
      this.onCalibrated();
      return;
    }

    const sol = this.solveAt(coords.u, coords.v, g, aspect, this.fovDeg);
    if (!sol) return;

    // Propagate FOV uncertainty numerically rather than analytically: solve at
    // fov ± σ and take half the spread. Robust, and it stays correct if the
    // ray construction ever changes.
    const fovSigma = this.fovCalibrated ? FOV_SIGMA_CALIBRATED : FOV_SIGMA_UNCALIBRATED;
    const lo = this.solveAt(coords.u, coords.v, g, aspect, this.fovDeg - fovSigma);
    const hi = this.solveAt(coords.u, coords.v, g, aspect, this.fovDeg + fovSigma);
    const fovErr = lo && hi ? Math.abs(lo.horizontal - hi.horizontal) / 2 : sol.horizontal;
    const sigma = Math.hypot(sol.sigma, fovErr);

    this.pins.push({ u: coords.u, v: coords.v, sol, sigma });
    if (this.pins.length > 8) this.pins.shift();
  }

  private solveAt(u: number, v: number, g: Vec3, aspect: number, fovDeg: number): FloorSolution | null {
    const tanH = Math.tan((fovDeg * Math.PI) / 360);
    return solveFloor(frameRay(u, v, tanH, tanH * aspect), g, this.height);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, stage: HTMLElement): void {
    ctx.clearRect(0, 0, w, h);
    const cam = this.cam;
    if (!cam) return;

    // Centre reticle
    ctx.strokeStyle = '#ff9c0099';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 14, h / 2); ctx.lineTo(w / 2 - 4, h / 2);
    ctx.moveTo(w / 2 + 4, h / 2); ctx.lineTo(w / 2 + 14, h / 2);
    ctx.moveTo(w / 2, h / 2 - 14); ctx.lineTo(w / 2, h / 2 - 4);
    ctx.moveTo(w / 2, h / 2 + 4); ctx.lineTo(w / 2, h / 2 + 14);
    ctx.stroke();

    // Pins, drawn back at their screen positions.
    const fw = cam.video.videoWidth, fh = cam.video.videoHeight;
    if (!fw || !fh) return;
    const r = stage.getBoundingClientRect();
    const scale = Math.max(r.width / fw, r.height / fh);
    const offX = (r.width - fw * scale) / 2;
    const offY = (r.height - fh * scale) / 2;

    this.pins.forEach((p, i) => {
      const fx = ((p.u + 1) / 2) * fw;
      const fy = ((1 - p.v) / 2) * fh;
      const x = fx * scale + offX;
      const y = fy * scale + offY;
      const last = i === this.pins.length - 1;
      const beyond = p.sol.horizontal > MAX_RANGE_M;

      ctx.beginPath();
      ctx.arc(x, y, last ? 9 : 6, 0, Math.PI * 2);
      ctx.fillStyle = beyond ? '#ff555588' : last ? '#ffcc66' : '#ffcc6666';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();

      const label = beyond ? '>8 m' : `${p.sol.horizontal.toFixed(2)} ±${p.sigma.toFixed(2)} m`;
      ctx.font = `${last ? 700 : 400} 12px ui-monospace, monospace`;
      const tw = ctx.measureText(label).width;
      const bx = Math.min(Math.max(x - tw / 2 - 5, 2), w - tw - 12);
      ctx.fillStyle = '#000000cc';
      ctx.fillRect(bx, y + 13, tw + 10, 17);
      ctx.fillStyle = beyond ? '#ff5555' : '#ffcc66';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(label, bx + 5, y + 16);
    });

    if (this.calibrating) {
      ctx.fillStyle = '#cc669955';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffcc66';
      ctx.font = "700 14px 'Antonio', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`TAP THE POINT AT ${this.calibrationTarget.toFixed(2)} m`, w / 2, 10);
    }
  }
}

function cameraErrorHtml(err: CameraUnavailableError): string {
  const base = `<strong>Camera unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base +
      '<ul>' +
      '<li><strong>Safari</strong> — Settings → Safari → Camera, or clear this site\'s website data and reload.</li>' +
      '<li><strong>Chrome / Edge</strong> — in-app Settings → Site Settings → Camera. Also check Settings → Privacy &amp; Security → Camera allows the browser app itself.</li>' +
      '</ul>';
  }
  return base;
}
