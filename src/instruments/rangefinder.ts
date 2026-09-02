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
import { frameRay, solveFloor, solveFovDeg, solveFovAndHeight, MAX_RANGE_M, type FloorSolution } from '../lib/rangefinder';
import { capabilities, fingerprint } from '../lib/capabilities';
import type { Vec3 } from '../lib/vec';
import * as storage from '../lib/storage';

/** Starting FOV before calibration. Nominal only — never presented as fact. */
const NOMINAL_FOV_DEG = 65;
/**
 * Minimum radius from frame centre for a SINGLE-POINT calibration tap.
 *
 * At the exact centre the view ray IS the optical axis, whatever the field of
 * view happens to be — so a lone centre tap carries no information about FOV
 * and the solver has nothing to fit. This is a trap rather than an edge case,
 * because centring the target is precisely what someone aiming a camera does
 * by reflex. Measurement taps are unaffected, and the two-point fit judges
 * itself by conditioning instead.
 */
const MIN_CAL_RADIUS = 0.25;

/** 1σ on the FOV: wide until measured, tight once solved against a tape. */
const FOV_SIGMA_UNCALIBRATED = 8;
/** Fallback 1σ for a single-point fit, which cannot measure its own conditioning. */
const FOV_SIGMA_ONE_POINT = 2;

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
  /** Measured 1σ on the calibrated FOV. Set by whichever calibration ran. */
  private fovSigma = FOV_SIGMA_UNCALIBRATED;
  private pins: Pin[] = [];
  /**
   * off      — measuring
   * one      — single-point: solve FOV, trusting the entered height
   * twoA/twoB — two-point: solve FOV and height together
   */
  private calMode: 'off' | 'one' | 'twoA' | 'twoB' = 'off';
  private calibrationTarget = 2.0;
  private pointA: { u: number; v: number; gDown: Vec3; distance: number } | null = null;

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
    this.fovSigma = stored === null
      ? FOV_SIGMA_UNCALIBRATED
      : storage.load<number>(this.fovKey + ':sigma', FOV_SIGMA_ONE_POINT);
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
        '<strong>Gravity sign convention is not calibrated.</strong> Every ray in this instrument is built from ĝ_down, so an inverted polarity makes every reading wrong rather than merely imprecise. Run Core → Gravity sign convention first.'));
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

    const btnCal = el('button', { class: 'btn', type: 'button' }, 'Calibrate FOV only');
    const btnCal2 = el('button', { class: 'btn', type: 'button' }, 'Calibrate FOV + height');
    const btnReset = el('button', { class: 'btn btn--alt', type: 'button' }, 'Reset calibration');

    const renderCal = () => {
      clear(calBox);
      append(calBox, notice(
        this.fovCalibrated ? 'ok' : 'warn',
        this.fovCalibrated
          ? `<strong>Calibrated.</strong> Effective horizontal FOV ${this.fovDeg.toFixed(2)}° ±${this.fovSigma.toFixed(1)}° for this browser and orientation. That uncertainty is measured, not assumed: it is how far the fit moves when the input distances are perturbed by 1%. Stored against the capability fingerprint, not the user-agent string — Safari and WKWebView may crop the stream differently.`
          : `<strong>Uncalibrated.</strong> Running on a nominal ${NOMINAL_FOV_DEG}° field of view, which is a guess. FOV is the dominant error source here and <code>getUserMedia</code> may crop relative to the native camera, so the uncertainty band below carries ±${FOV_SIGMA_UNCALIBRATED}° of FOV ignorance. ` +
            '<strong>Prefer the two-point calibration.</strong> A single known distance cannot separate field of view from camera height — a reading 12% low is explained equally well by either — so a one-point fit reads perfectly at its own calibration distance and wrongly at every other one. Two points at different distances solve for both.'));
      if (this.calError) append(calBox, notice('bad', this.calError));
      if (this.calMode === 'one') {
        append(calBox, notice('warn',
          `<strong>Single-point calibration.</strong> Tap exactly where the object at ${this.calibrationTarget.toFixed(2)} m meets the floor. This solves for field of view <em>assuming the entered height is correct</em> — if it is not, the reading will be exact here and wrong everywhere else.`));
      } else if (this.calMode === 'twoA') {
        append(calBox, notice('warn',
          `<strong>Two-point calibration, first point.</strong> Set the distance above to your nearer target and tap where it meets the floor. Currently ${this.calibrationTarget.toFixed(2)} m. ` +
          'Frame this one <em>low</em>, near the bottom edge. The second should sit much closer to the middle: it is the difference in where they fall in the frame that separates field of view from height, so keep the phone at a similar tilt for both and let the framing differ. Do not change how high you hold the phone.'));
      } else if (this.calMode === 'twoB') {
        append(calBox, notice('warn',
          `<strong>Two-point calibration, second point.</strong> First point captured at ${this.pointA?.distance.toFixed(2)} m. Now set the distance above to your further target — at least 1.6× the first — and tap where <em>it</em> meets the floor, holding the phone at the same height.`));
      }
    };

    btnCal.addEventListener('click', () => {
      this.calMode = this.calMode === 'one' ? 'off' : 'one';
      this.calError = null;
      this.pointA = null;
      renderCal();
    });
    btnCal2.addEventListener('click', () => {
      this.calMode = this.calMode === 'off' ? 'twoA' : 'off';
      this.calError = null;
      this.pointA = null;
      renderCal();
    });
    btnReset.addEventListener('click', () => {
      storage.remove(this.fovKey);
      storage.remove(this.fovKey + ':sigma');
      this.loadFov();
      this.calMode = 'off';
      this.calError = null;
      this.pointA = null;
      this.pins = [];
      renderCal();
    });

    append(scroll,
      section('FOV calibration'),
      calBox,
      el('div', { class: 'rf__row' },
        el('label', { class: 'rf__label', text: 'Known distance (m)' }), dInput),
      el('div', { class: 'btn-row' }, btnCal2, btnCal, btnReset));
    renderCal();
    this.onCalibrated = () => {
      hInput.value = this.height.toFixed(2);
      renderCal();
    };

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
        this.fovCalibrated ? `calibrated ±${fmt(this.fovSigma, 1)}° (measured)` : `nominal ±${FOV_SIGMA_UNCALIBRATED}° — not measured`);
      rFov.setState(this.fovCalibrated ? 'ok' : 'warn');

      this.drawOverlay(octx, r.width, r.height, stage);
    });
  }

  private onCalibrated: () => void = () => {};
  private calError: string | null = null;

  private onTap(clientX: number, clientY: number, stage: HTMLElement): void {
    const cam = this.cam;
    const g = this.gDown;
    if (!cam || !g) return;

    const fw = cam.video.videoWidth;
    const fh = cam.video.videoHeight;
    const coords = tapToFrameCoords(clientX, clientY, stage, fw, fh, 'cover');
    if (!coords) return;

    const aspect = fh / fw;

    // Single-point only. A centre tap is useless on its own, because the ray
    // there is the optical axis whatever the field of view is — but as one of
    // a PAIR it is perfectly good: the off-centre tap carries the lens
    // information while the central one pins tilt and height. What the two-
    // point fit needs is that the taps DIFFER, and its conditioning check
    // measures that directly and better than any per-tap rule could.
    if (this.calMode === 'one') {
      const radius = Math.hypot(coords.u, coords.v);
      if (radius < MIN_CAL_RADIUS) {
        this.calError =
          `That tap is too close to the centre of the frame (${radius.toFixed(2)} from centre, need ${MIN_CAL_RADIUS}). ` +
          'At the centre the view ray is the optical axis no matter what the field of view is, so a lone tap there tells the solver nothing about it. ' +
          'Re-aim so the target sits well away from the middle — near the bottom of the frame is natural for a floor point — and tap again.';
        this.onCalibrated();
        return;
      }
    }

    // Single-point only. A centre tap is useless on its own, because the ray
    // there is the optical axis whatever the field of view is — but as one of
    // a PAIR it is perfectly good: the off-centre tap carries the lens
    // information while the central one pins tilt and height. What the two-
    // point fit needs is that the taps DIFFER, and its conditioning check
    // measures that directly and better than any per-tap rule could.
    if (this.calMode === 'one') {
      const radius = Math.hypot(coords.u, coords.v);
      if (radius < MIN_CAL_RADIUS) {
        this.calError =
          `That tap is too close to the centre of the frame (${radius.toFixed(2)} from centre, need ${MIN_CAL_RADIUS}). ` +
          'At the centre the view ray is the optical axis no matter what the field of view is, so a lone tap there tells the solver nothing about it. ' +
          'Re-aim so the target sits well away from the middle — near the bottom of the frame is natural for a floor point — and tap again.';
        this.onCalibrated();
        return;
      }
    }

    if (this.calMode === 'one') {
      const fov = solveFovDeg(coords.u, coords.v, g, this.height, this.calibrationTarget, aspect);
      this.calMode = 'off';
      if (fov === null) { this.calError = 'No field of view in range fits that tap. Check the height and the distance, and tap exactly where the object meets the floor.'; this.onCalibrated(); return; }
      this.fovDeg = fov;
      this.fovCalibrated = true;
      this.fovSigma = FOV_SIGMA_ONE_POINT;
      storage.save(this.fovKey, fov);
      storage.save(this.fovKey + ':sigma', FOV_SIGMA_ONE_POINT);
      this.pins = [];
      this.calError = null;
      this.onCalibrated();
      return;
    }

    if (this.calMode === 'twoA') {
      this.pointA = { u: coords.u, v: coords.v, gDown: g, distance: this.calibrationTarget };
      this.calMode = 'twoB';
      this.calError = null;
      this.onCalibrated();
      return;
    }

    if (this.calMode === 'twoB') {
      const a = this.pointA!;
      const b = { u: coords.u, v: coords.v, gDown: g, distance: this.calibrationTarget };
      this.calMode = 'off';
      // No distance-ratio rule here. It was a proxy for conditioning, and a
      // poor one: what actually determines whether the fit can separate field
      // of view from height is how differently the two taps fall in the FRAME,
      // not how far apart the targets are. The fit measures its own
      // conditioning directly, which is both stricter and correct.
      const fit = solveFovAndHeight(a, b, aspect);
      if (!fit) {
        this.calError = 'No field of view and height pair fits those two taps. Most likely the phone moved vertically between them, or a tap missed the point where the object meets the floor.';
        this.onCalibrated();
        return;
      }
      if (!fit.wellConditioned) {
        // Refuse rather than store it. A calibration no better than the guess
        // it replaces, presented as a calibration, is worse than no
        // calibration at all — it looks trustworthy.
        this.calError =
          `Those two taps do not constrain the optics: a 1% error in either distance moves the fitted field of view by ±${Number.isFinite(fit.fovSensitivity) ? fit.fovSensitivity.toFixed(1) : '∞'}°, which is no better than the uncalibrated guess. ` +
          'The field-of-view information comes from the two taps sitting at different places <em>in the frame</em>, not from the phone being tilted differently between them — tilt changes the angle without exercising the lens. ' +
          'Keep the phone at roughly the same tilt for both, and pick targets that land near the bottom edge and nearer the middle of the frame.';
        this.onCalibrated();
        return;
      }
      this.fovDeg = fit.fovDeg;
      this.height = fit.height;
      this.fovCalibrated = true;
      this.fovSigma = Math.max(fit.fovSensitivity, 0.5);
      storage.save(this.fovKey, fit.fovDeg);
      storage.save(this.fovKey + ':sigma', this.fovSigma);
      storage.save('rangefinder:height', fit.height);
      this.pins = [];
      this.calError = null;
      this.onCalibrated();
      return;
    }

    const sol = this.solveAt(coords.u, coords.v, g, aspect, this.fovDeg);
    if (!sol) return;

    // Propagate FOV uncertainty numerically rather than analytically: solve at
    // fov ± σ and take half the spread. Robust, and it stays correct if the
    // ray construction ever changes.
    const lo = this.solveAt(coords.u, coords.v, g, aspect, this.fovDeg - this.fovSigma);
    const hi = this.solveAt(coords.u, coords.v, g, aspect, this.fovDeg + this.fovSigma);
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

    if (this.calMode !== 'off') {
      ctx.fillStyle = '#cc669955';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ffcc66';
      ctx.font = "700 14px 'Antonio', sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = this.calMode === 'twoB' ? 'SECOND POINT' : this.calMode === 'twoA' ? 'FIRST POINT' : 'CALIBRATE';
      ctx.fillText(`${label} — TAP AT ${this.calibrationTarget.toFixed(2)} m`, w / 2, 10);
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
