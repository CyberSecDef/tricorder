/**
 * Core (§9) — the one panel that is about the tricorder rather than about the
 * world. Every other screen measures something external; this one reports what
 * the device itself can do, how it is configured, and what it is.
 *
 * Formerly "Diagnostics", and diagnostics is still the bulk of it: "it costs an
 * hour and will save days of remote debugging across three browsers" — so it
 * lists every detected capability, the runtime audio sample rate, the resolved
 * gravity sign convention, and live sensor liveness, plus the gravity
 * calibration that resolves §11 question 1. The name widened because the panel
 * is also where settings, benchmarks and about-this-build belong; they are not
 * built yet, and nothing here pretends otherwise.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { refresh, fingerprint } from '../lib/capabilities';
import { unlockResult, getAudioContext } from '../lib/permissions';
import { motion } from '../sensors/motion';
import { orientation } from '../sensors/orientation';
import { gravity, calibration, calibrateFromFlat, resetCalibration } from '../sensors/gravity';
import * as wakelock from '../lib/wakelock';
import { probeCameraCapabilities, CameraUnavailableError } from '../sensors/camera';
import { TARGET, describeShell, type ExpectedCapability } from '../lib/platform';
import { BUILD } from '../lib/build';
import type { Vec3 } from '../lib/vec';
import { lerp, len } from '../lib/vec';
import { setMode, mode, onThemeChange } from '../ui/theme';
import { SCHEMES, RAIL_ROTATION, type Scheme } from '../ui/palette';

type State = 'ok' | 'warn' | 'bad' | '';

export class CoreInstrument extends Instrument {
  readonly id = 'core';
  readonly title = 'Core';
  override readonly subtitle = 'Diagnostics · calibration';
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

    // --- About (§19) ------------------------------------------------------
    // First: what this is and exactly which build you are looking at. Every
    // bug report about this app starts by needing the row below.
    append(scroll, section('About'), this.buildAbout());

    // --- Mode (§18) -------------------------------------------------------
    append(scroll, section('Mode'), this.buildModePicker());

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

    // --- Camera capabilities (§11 q.4) ------------------------------------
    // Behind a button, not automatic: §4 is clear that the camera is acquired
    // by the screen that needs it, and a device panel that silently lights
    // the privacy indicator on arrival would be exactly the alarming behaviour
    // that section warns against. The probe releases the track immediately.
    const camBox = el('div');
    const btnCam = el('button', { class: 'btn', type: 'button' }, 'Probe camera capabilities');
    btnCam.addEventListener('click', async () => {
      btnCam.disabled = true;
      btnCam.textContent = 'Probing…';
      clear(camBox);
      try {
        const p = await probeCameraCapabilities();
        const rows: Array<[string, string, State]> = [
          ['exposureTime', yn(p.hasExposureTime), p.hasExposureTime ? 'ok' : 'warn'],
          ['iso', yn(p.hasIso), p.hasIso ? 'ok' : 'warn'],
          ['torch', yn(p.hasTorch), ''],
          ['capability keys', p.keys.length ? p.keys.join(', ') : '(none reported)', ''],
        ];
        append(camBox, table(rows));
        const lux = p.hasExposureTime && p.hasIso;
        append(camBox, notice(lux ? 'ok' : 'warn', lux
          ? '<strong>A calibrated lux meter is possible.</strong> Both <code>exposureTime</code> and <code>iso</code> are exposed, so <code>L ≈ (N²/t)·(K/S)</code> can be evaluated with a fixed aperture and K ≈ 12.5.'
          : '<strong>Only a relative light meter is possible.</strong> ' +
            (p.keys.length
              ? 'The track reports the keys above, but not both of <code>exposureTime</code> and <code>iso</code>, so the exposure equation cannot be evaluated. '
              : 'The track reports no adjustable capabilities at all, which is the usual answer on iOS. ') +
            'Derive a relative reading from mean frame luminance instead, and label it as relative.'));
      } catch (e) {
        const err = e as CameraUnavailableError;
        append(camBox, notice('bad', `<strong>Could not probe the camera.</strong> ${escapeHtml(err.message)}`));
      }
      btnCam.disabled = false;
      btnCam.textContent = 'Probe camera capabilities';
    });

    append(scroll, section('Camera capabilities — §11 q.4'),
      notice('warn', 'Asks the camera what it can do, then releases it immediately. Decides whether a <strong>calibrated</strong> lux meter is possible, or only a relative one.'),
      el('div', { class: 'btn-row' }, btnCam), camBox);

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

  /**
   * About: identity, provenance, and credit.
   *
   * The provenance rows are the point. "It works on my phone" is worthless
   * without knowing which build was on the phone, and a version number alone
   * does not distinguish two builds of 0.1.0 a week apart. Commit, branch,
   * dirty flag and build time together do.
   */
  private buildAbout(): HTMLElement {
    const box = el('div');
    const { shell, engine } = describeShell();

    // Read off the rail rather than importing NAV — main.ts imports this file,
    // so importing it back would be a cycle, and a hard-coded count is a
    // number that goes stale the next time an instrument lands.
    const railCount = document.querySelectorAll('.rail__btn').length;
    const instruments = railCount > 1 ? `${railCount - 1} instruments + Core` : 'unknown';

    const build = BUILD.commit
      ? `${BUILD.commit}${BUILD.dirty ? ' + uncommitted changes' : ''}${BUILD.branch ? ` (${BUILD.branch})` : ''}`
      : 'unknown — built outside a git checkout';

    append(box, table([
      ['name', 'Tricorder', ''],
      ['version', BUILD.version ?? 'unknown', ''],
      ['build', build, BUILD.commit ? (BUILD.dirty ? 'warn' : 'ok') : 'warn'],
      ['built', stamp(BUILD.builtAt), ''],
      ['source dated', BUILD.committedAt ? stamp(BUILD.committedAt) : 'unknown', ''],
      ['instruments', instruments, ''],
      ['target platform', TARGET.os, ''],
      ['verified on', TARGET.testedOn, ''],
      ['this browser', shell, ''],
      ['engine', engine, ''],
      ['licence', 'MIT', 'ok'],
    ]));

    append(box, notice('warn',
      '<strong>What this is.</strong> A tricorder that only reports things it can actually measure. ' +
      'Every readout is a real measurement from a real sensor; anything derived, uncalibrated or ' +
      'relative says so on its own face, and an instrument that cannot honestly measure its quantity ' +
      'on this hardware is not shipped rather than faked. Two of the original ten are absent for ' +
      'exactly that reason, and Core lists the APIs iOS does not provide so a future reader does not ' +
      'go hunting for them.'));

    // Deliberately NOT a .dtable. That table is built for short diagnostic
    // values — nowrap keys, break-word values — and credits are prose: it
    // hyphenates "CupcakeEternity" into "CupcakeEte / rnity". Names read on
    // one line, the credit beneath.
    append(box, section('Built on'), credits([
      ['Antonio', 'Vernon Adams and contributors. SIL Open Font License 1.1.'],
      ['LCARS colour schemes', 'CupcakeEternity — “Starfleet LCARS Colour Schemes · 25th Century” (2021). Seven of the eight Mode palettes are sampled from it.'],
      ['Depth Anything V2 (small)', 'Yang et al. Monocular depth estimation. Apache 2.0.'],
      ['Transformers.js', 'Hugging Face. Runs the depth model in the browser. Apache 2.0.'],
      ['ONNX Runtime Web', 'Microsoft. WebGPU inference, with a WASM fallback. MIT.'],
      ['zxing-wasm', 'ZXing contributors. Barcode and QR decoding. Apache 2.0.'],
      ['Vite · TypeScript', 'Build toolchain. No runtime framework — the app ships no UI library at all.'],
    ]));

    append(box, notice('ok',
      '<strong>MIT licensed.</strong> Reuse it, modify it, ship it commercially — the only condition is ' +
      'that the copyright notice and licence text travel with it. It comes with no warranty and the ' +
      'authors carry no liability. Full text in <code>LICENSE</code>.'));

    append(box, notice('warn',
      '<strong>Antonio is fetched from Google Fonts,</strong> which is the only request this app makes ' +
      'to anything other than its own origin. Everything else — the depth model, the barcode decoder, ' +
      'the inference runtime — is served from here. Vendor the font before a public deploy and the app ' +
      'talks to nobody.'));

    return box;
  }

  /**
   * Colour-scheme picker. Each button previews the scheme it selects, in the
   * scheme's own colours: the frame stripe, then the four rail colours in the
   * order the rail actually cycles them. A palette chooser rendered in the
   * current palette would be a list of names, which tells the user nothing.
   */
  private buildModePicker(): HTMLElement {
    const wrap = el('div', { class: 'modes' });
    const buttons = new Map<string, HTMLElement>();

    for (const sc of SCHEMES) {
      const swatches = el('div', { class: 'mode__swatches' },
        ...RAIL_ROTATION.map((r) =>
          el('span', { class: 'mode__sw', style: `background:${sc.palette[r]}` })));

      const btn = el('button', {
        class: 'mode', type: 'button',
        'data-mode': sc.id,
        'aria-pressed': String(sc.id === mode()),
        title: `${sc.name} — ${sc.use}`,
      },
        el('span', { class: 'mode__bar', style: `background:${sc.palette.frame}` }),
        el('span', { class: 'mode__name', text: sc.short }),
        swatches);

      btn.addEventListener('click', () => setMode(sc.id));
      buttons.set(sc.id, btn);
      append(wrap, btn);
    }

    const caption = el('div', { class: 'mode__caption' });
    const describe = (): void => {
      const sc: Scheme = SCHEMES.find((x) => x.id === mode()) ?? SCHEMES[0];
      clear(caption);
      append(caption, el('strong', { text: sc.name }), el('span', { text: ` — ${sc.use}` }));
      for (const [id, b] of buttons) b.setAttribute('aria-pressed', String(id === mode()));
    };
    describe();
    this.onCleanup(onThemeChange(describe));

    return el('div', {}, wrap, caption,
      notice('warn',
        'Seven of these are sampled from CupcakeEternity’s <em>Starfleet LCARS Colour Schemes · 25th Century</em> chart; ' +
        '<strong>Standard</strong> is this app’s original palette. The choice is remembered on this device. ' +
        '<strong>The three state colours — ok, caution, failure — do not change with the mode</strong>, deliberately: ' +
        'Red Alert would otherwise render all three in the same red, and every readout here is a measurement whose state you are meant to be able to read at a glance.'));
  }
}

const yn = (b: boolean): string => (b ? 'yes' : 'no');

/** Attribution list: a name, and the credit underneath it. */
function credits(rows: Array<[string, string]>): HTMLElement {
  const wrap = el('div', { class: 'credits' });
  for (const [name, by] of rows) {
    append(wrap, el('div', { class: 'credit' },
      el('div', { class: 'credit__name', text: name }),
      el('div', { class: 'credit__by', text: by })));
  }
  return wrap;
}

/** ISO timestamp → something a person can read, in their own timezone. */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}
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

