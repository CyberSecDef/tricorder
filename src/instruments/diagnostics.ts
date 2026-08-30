/**
 * Diagnostics (§9). "It costs an hour and will save days of remote debugging
 * across three browsers" — so it lists every detected capability, the runtime
 * audio sample rate, the resolved gravity sign convention, and live sensor
 * liveness, plus the gravity calibration that resolves §11 question 1.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { refresh, fingerprint } from '../lib/capabilities';
import { unlockResult, getAudioContext } from '../lib/permissions';
import { motion } from '../sensors/motion';
import { orientation } from '../sensors/orientation';
import { gravity, calibration, calibrateFromFlat, resetCalibration } from '../sensors/gravity';
import * as wakelock from '../lib/wakelock';
import { TARGET, type ExpectedCapability } from '../lib/platform';
import type { Vec3 } from '../lib/vec';
import { lerp, len } from '../lib/vec';

type State = 'ok' | 'warn' | 'bad' | '';

export class DiagnosticsInstrument extends Instrument {
  readonly id = 'diag';
  readonly title = 'Diagnostics';
  override readonly subtitle = 'Capabilities · calibration';
  override readonly resources = 'motion + orientation';

  private motionCount = 0;
  private orientCount = 0;
  private lastMotionAt = 0;
  private lastOrientAt = 0;
  private accelG: Vec3 | null = null;
  private smoothedG: Vec3 | null = null;

  protected build(root: HTMLElement): void {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    const caps = refresh();
    const unlocked = unlockResult();
    const ctx = getAudioContext();

    // --- Capability table -------------------------------------------------
    const rows: Array<[string, string, State]> = [
      ['secure context', yn(caps.secureContext), caps.secureContext ? 'ok' : 'bad'],
      ['origin', location.origin, ''],
      ['display mode', caps.standalone ? 'standalone (installed)' : 'browser tab', ''],
      ['DeviceMotionEvent', yn(caps.deviceMotion), caps.deviceMotion ? 'ok' : 'bad'],
      ['  .requestPermission gate', yn(caps.motionGate), caps.motionGate ? 'ok' : 'warn'],
      ['DeviceOrientationEvent', yn(caps.deviceOrientation), caps.deviceOrientation ? 'ok' : 'bad'],
      ['  .requestPermission gate', yn(caps.orientGate), caps.orientGate ? 'ok' : 'warn'],
      ['webkitCompassHeading', yn(caps.compass), caps.compass ? 'ok' : 'bad'],
      ['geolocation', yn(caps.geolocation), caps.geolocation ? 'ok' : 'bad'],
      ['getUserMedia', yn(caps.mediaDevices), caps.mediaDevices ? 'ok' : 'bad'],
      ['Web Audio', yn(caps.webAudio), caps.webAudio ? 'ok' : 'bad'],
      ['AudioWorklet', yn(caps.audioWorklet), caps.audioWorklet ? 'ok' : 'warn'],
      ['Wake Lock', yn(caps.wakeLock), caps.wakeLock ? 'ok' : 'warn'],
      ['WebGPU', yn(caps.webgpu), caps.webgpu ? 'ok' : 'warn'],
      ['navigator.vibrate', yn(caps.vibrate), ''],
      ['SharedArrayBuffer', yn(caps.sharedArrayBuffer), ''],
      ['crossOriginIsolated', yn(caps.crossOriginIsolated), ''],
      ['capability fingerprint', fingerprint(caps), ''],
    ];

    append(scroll, section('Capabilities'), table(rows));

    // We target iOS 26+, which guarantees these. If one is missing here, the
    // interesting question is not "does this browser have it" but "why does
    // this WKWebView differ from Safari at the same OS version" (§1, §11 q.6).
    const missing = (Object.keys(TARGET.expected) as ExpectedCapability[])
      .filter((k) => TARGET.expected[k] && !caps[k]);
    append(scroll, notice(missing.length ? 'bad' : 'ok',
      missing.length
        ? `<strong>Below target.</strong> ${escapeHtml(TARGET.os)} should provide ` +
          `<code>${missing.map(escapeHtml).join('</code>, <code>')}</code>, and this browser does not. ` +
          'That is a real divergence worth recording — note which browser you are in.'
        : `<strong>Meets target.</strong> Every capability ${escapeHtml(TARGET.os)} guarantees is present. ` +
          `Reference device: ${escapeHtml(TARGET.testedOn)}.`));

    // --- Permissions & audio ---------------------------------------------
    const permRows: Array<[string, string, State]> = [
      ['motion permission', unlocked?.motion ?? 'not run', st(unlocked?.motion)],
      ['orientation permission', unlocked?.orientation ?? 'not run', st(unlocked?.orientation)],
      ['audio context', unlocked?.audio ?? 'not run', st(unlocked?.audio)],
      ['audioCtx.state', ctx?.state ?? '—', ctx?.state === 'running' ? 'ok' : 'warn'],
      ['audioCtx.sampleRate', ctx ? `${ctx.sampleRate} Hz` : '—', 'ok'],
      ['nyquist', ctx ? `${(ctx.sampleRate / 2000).toFixed(1)} kHz` : '—', ''],
      ['ultrasonic ceiling', ctx ? (ctx.sampleRate >= 48000 ? '22 kHz usable' : '~20 kHz — narrow the chirp') : '—',
        ctx ? (ctx.sampleRate >= 48000 ? 'ok' : 'warn') : ''],
      ['wake lock held', yn(wakelock.held()), wakelock.held() ? 'ok' : 'warn'],
      ['target platform', TARGET.os, ''],
      ['depth backend', caps.webgpu ? 'webgpu (when Instrument 9 ships)' : 'wasm fallback — slow', caps.webgpu ? 'ok' : 'warn'],
    ];
    append(scroll, section('Runtime'), table(permRows));

    if (unlocked?.errors.length) {
      append(scroll, notice('bad',
        `<strong>Boot errors:</strong><ul>${unlocked.errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`));
    }

    // --- Live sensor liveness --------------------------------------------
    const rMotionHz = readout('devicemotion', { unit: 'Hz', note: '' });
    const rOrientHz = readout('deviceorientation', { unit: 'Hz', note: '' });
    const rGravity = readout('Gravity magnitude', { unit: 'm/s²', note: '' });
    append(scroll, section('Sensor liveness'),
      el('div', { class: 'grid' }, rMotionHz.node, rOrientHz.node, rGravity.node));

    // --- Gravity calibration (§7, §11 q.1) -------------------------------
    const calBox = el('div');
    const rawRead = readout('accelerationIncludingGravity', { unit: 'm/s²', note: 'raw, low-passed', wide: true });
    const btnCal = el('button', { class: 'btn', type: 'button' }, 'Calibrate — phone flat, screen up');
    const btnReset = el('button', { class: 'btn btn--warn', type: 'button' }, 'Clear calibration');
    const calStatus = el('div');

    const renderCal = () => {
      const c = calibration();
      clear(calStatus);
      append(calStatus, notice(c.verified ? 'ok' : 'warn',
        c.verified
          ? `<strong>Calibrated.</strong> Sign convention <code>${c.sign > 0 ? '+1' : '−1'}</code>, derived from a flat screen-up reading of <code>${c.observed ? vecStr(c.observed) : '—'}</code>. ` +
            `A reading of <code>z ≈ −9.81</code> means this engine reports the iOS convention; <code>z ≈ +9.81</code> means the W3C one.`
          : '<strong>Not calibrated.</strong> §7 warns that the sign convention of <code>accelerationIncludingGravity</code> differs between iOS and the W3C spec, and that a remembered polarity should not be trusted. Until you calibrate, pitch/roll polarity and every future gravity-derived instrument run on an assumption. Lay the phone flat, screen up, on a level surface and press the button.'));
    };

    btnCal.addEventListener('click', () => {
      const g = this.smoothedG;
      if (!g) { btnCal.textContent = 'No motion data yet'; return; }
      if (Math.abs(len(g) - 9.80665) > 0.6) {
        btnCal.textContent = 'Hold still and flat — retry';
        setTimeout(() => { btnCal.textContent = 'Calibrate — phone flat, screen up'; }, 1800);
        return;
      }
      calibrateFromFlat(g);
      renderCal();
      btnCal.textContent = 'Calibrated ✓';
      setTimeout(() => { btnCal.textContent = 'Re-calibrate — phone flat, screen up'; }, 1800);
    });

    btnReset.addEventListener('click', () => { resetCalibration(); renderCal(); });

    append(scroll,
      section('Gravity sign convention'),
      rawRead.node,
      calStatus,
      el('div', { class: 'btn-row' }, btnCal, btnReset),
      calBox);
    renderCal();

    // --- Known-absent APIs -----------------------------------------------
    append(scroll, section('Absent on iOS — by design, not a bug'),
      notice('warn',
        'None of these exist in <em>any</em> browser on iOS, because Chrome and Edge on iOS are WebKit. ' +
        'They are listed so a future reader does not go looking: ' +
        '<code>Magnetometer</code>, <code>Accelerometer</code>, <code>Gyroscope</code>, <code>AmbientLightSensor</code> ' +
        '(the whole Generic Sensor API), WebXR, Web Bluetooth, Web NFC, WebUSB, Web Serial, Battery Status, ' +
        '<code>navigator.vibrate</code>, LiDAR, and <code>deviceorientationabsolute</code>. ' +
        'Raw magnetic field strength in µT is not obtainable — Instrument 7 detects anomalies instead.'));

    // --- Streams ----------------------------------------------------------
    this.sub(motion, (m) => {
      this.motionCount++;
      this.lastMotionAt = performance.now();
      if (m.accelG) {
        this.accelG = m.accelG;
        this.smoothedG = this.smoothedG === null ? m.accelG : lerp(this.smoothedG, m.accelG, 0.08);
      }
    });
    this.sub(orientation, () => { this.orientCount++; this.lastOrientAt = performance.now(); });
    this.sub(gravity, (g) => {
      rGravity.set(fmt(g.magnitude, 3), `down: ${vecStr(g.down, 3)}`);
      rGravity.setState(g.settled ? 'ok' : 'warn');
    });

    // Rate is measured over a 1 s window rather than instantaneously — the
    // iOS event clock jitters enough to make a per-event rate meaningless.
    let lastTick = performance.now();
    this.every(1000, () => {
      const now = performance.now();
      const span = (now - lastTick) / 1000;
      lastTick = now;
      const mHz = this.motionCount / span;
      const oHz = this.orientCount / span;
      this.motionCount = 0;
      this.orientCount = 0;

      const mStale = now - this.lastMotionAt > 2000;
      const oStale = now - this.lastOrientAt > 2000;
      rMotionHz.set(mStale ? '0.0' : fmt(mHz, 1), mStale ? 'no events — permission denied or toggle off' : 'live');
      rMotionHz.setState(mStale ? 'bad' : mHz > 45 ? 'ok' : 'warn');
      rOrientHz.set(oStale ? '0.0' : fmt(oHz, 1), oStale ? 'no events' : 'live');
      rOrientHz.setState(oStale ? 'bad' : oHz > 20 ? 'ok' : 'warn');
    });

    this.loop(() => {
      const g = this.accelG;
      const s = this.smoothedG;
      rawRead.set(s ? vecStr(s, 3) : '—',
        g ? `instantaneous ${vecStr(g, 2)} · |g| ${fmt(s ? len(s) : 0, 3)}` : 'awaiting devicemotion');
      rawRead.setState(s ? (Math.abs(len(s) - 9.80665) < 0.4 ? 'ok' : 'warn') : 'idle');
    });
  }
}

const yn = (b: boolean): string => (b ? 'yes' : 'no');
const st = (v: string | undefined): State =>
  v === 'granted' ? 'ok' : v === 'denied' ? 'bad' : v === undefined ? '' : 'warn';

const vecStr = (v: Vec3, d = 2): string => `${v.x.toFixed(d)}, ${v.y.toFixed(d)}, ${v.z.toFixed(d)}`;

function table(rows: Array<[string, string, State]>): HTMLElement {
  const t = el('table', { class: 'dtable' });
  const body = el('tbody');
  for (const [k, v, s] of rows) {
    const tr = el('tr', {}, el('td', { text: k }), el('td', { text: v }));
    if (s) tr.dataset.state = s;
    append(body, tr);
  }
  append(t, body);
  return t;
}

