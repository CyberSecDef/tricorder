/**
 * NOT IN THE NAVIGATION RAIL — no signal exists for it on iOS 26.6.1.
 *
 * This instrument is correct and works. It reaches a 0.0084 degree noise floor
 * and fires at 0.067 degrees of unexplained heading change. What it does not
 * have is anything to detect: on the reference device the fused heading handed
 * to the browser does not respond to a magnet at all — not a large one, not at
 * any distance or angle, not spun, not while rotating past it. Raw
 * webkitCompassHeading never moves, and Apple's own Compass app shows the same
 * nothing, so the rejection happens well upstream of this code.
 *
 * An earlier session did record a clear response, 691x the noise floor, with
 * webkitCompassAccuracy corroborating. It has never reproduced. That result and
 * its retraction are documented in §8.7 of the handoff, along with four
 * candidate explanations and the one stimulus still worth trying: a ferrous
 * mass rather than a magnet.
 *
 * Kept in the tree, and kept compiling, because it IS the test. If a future
 * iOS release or a different device behaves differently, re-enabling it is one
 * import and one line in main.ts.
 *
 * Instrument 7 — Magnetic anomaly detector (§8.7).
 *
 * The raw magnetometer is unreachable in every iOS browser, so this does not
 * report field strength and never will. What it reports is DISTURBANCE, from
 * two signals, and it labels the result a relative index because that is what
 * it is.
 *
 * Signal B (primary) — the gyro/compass residual. The gyroscope is
 * magnetically immune and the compass is not, so their disagreement is the
 * field changing underneath a device that did not move.
 *
 * Signal A (corroboration) — webkitCompassAccuracy. iOS's own estimate of how
 * wrong the heading is.
 *
 * Everything below is shaped by what §11 q.2 actually measured on device
 * rather than by what the handoff guessed:
 *
 *   - Signal B is NOT damped by Core Motion. Noise floor 0.021° RMS resting on
 *     a table; 14.28° peak with a neodymium magnet at the top of the phone.
 *     691x. It is the strongest signal in the instrument set.
 *   - Signal A responds but lags by seconds and missed one of two transients
 *     in the same recording. It corroborates; it does not detect.
 *   - Compass calibration gates everything. At 89° accuracy the heading wanders
 *     60° unprompted — a false anomaly larger than any real one — so the
 *     instrument refuses to report an index until iOS says the compass is good.
 *   - The index is expressed in multiples of a measured noise floor, not in
 *     degrees, because the floor is what makes 14° meaningful.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, clear } from '../ui/dom';
import { residual, resetFilters, type ResidualSample } from '../sensors/residual';
import { angleDelta } from '../lib/vec';
import { theme, alpha } from '../ui/theme';

/** Above this webkitCompassAccuracy the heading wanders more than a magnet moves it. */
const MAX_USABLE_ACCURACY = 20;
/** Seconds of quiet used to learn the noise floor before reporting an index. */
const LEARN_S = 3;
/** Never divide by a floor below this, in degrees. Measured floors are ~0.02. */
const MIN_FLOOR = 0.005;
/** Index at which we call it an anomaly. */
const ALERT_SIGMA = 8;
/** The floor only tracks quiet: above this multiple we stop updating it. */
const FLOOR_FREEZE_SIGMA = 4;
/** Time constant for the quiet-period floor tracker, seconds. */
const FLOOR_TAU = 30;
/**
 * Time constant for the gyro-bias tracker, seconds.
 *
 * This instrument does its own bias removal rather than using the stream's
 * detrended output, for one reason: the tracker must FREEZE while an anomaly
 * is in progress. A plain EMA charges up during the event, so when the event
 * ends the corrected residual swings the other way and stays there for a full
 * time constant — the detector reports a phantom anomaly for 25 s after every
 * real one, and never re-arms. Freezing while triggered makes recovery
 * immediate. Gyro bias is slow and always present; it does not need tracking
 * during the few seconds an anomaly lasts.
 */
const BIAS_TAU = 25;
/** Rolling trace length, ~15 s at 60 Hz. */
const TRACE_N = 900;

interface Event { start: number; end: number; peak: number; peakAcc: number }

export class MagneticInstrument extends Instrument {
  readonly id = 'magnetic';
  readonly title = 'Magnetic Anomaly';
  override readonly subtitle = 'Relative index · no µT reading exists';
  override readonly resources = 'orientation + motion';

  private floor: number | null = null;
  private bias = 0;
  private biasPrimed = false;
  private learnStart = 0;
  private learnSum = 0;
  private learnCount = 0;
  private index = 0;
  private corrected = 0;
  private peakIndex = 0;
  private sample: ResidualSample | null = null;
  private baseAccuracy: number | null = null;
  /**
   * Raw heading bookkeeping.
   *
   * The index is a derived quantity two transforms away from the sensor, so a
   * flat index has several possible causes and they are not distinguishable
   * from the index alone. The heading is the last observable before iOS's
   * fusion hands anything over: if it does not move, nothing downstream can,
   * and the cause is upstream of this app entirely.
   */
  private headingRef: number | null = null;
  private headingDev = 0;
  private headingPeakDev = 0;
  private headingChanges = 0;
  private lastHeadingValue: number | null = null;
  private lastHeadingChangeAt = 0;
  private trace: Array<{ index: number; acc: number }> = [];
  private events: Event[] = [];
  private inEvent: Event | null = null;

  protected build(root: HTMLElement): void {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    // A fresh session must not inherit filter state (see residual.ts).
    resetFilters();
    this.reset();

    // Status first. An error that explains why every number is a dash belongs
    // above the dashes, not three sections below them.
    const stateBox = el('div');

    append(scroll, notice('warn',
      '<strong>This is a relative index, not a field strength.</strong> No iOS browser can read the magnetometer, so no µT value is obtainable and none is shown. ' +
      'What is measured is the disagreement between the gyroscope, which magnetism cannot touch, and the compass, which it can. The index is that disagreement expressed in multiples of this device\'s own measured noise floor.'));

    // --- primary readouts -------------------------------------------------
    const rIndex = readout('Anomaly index', { unit: '× noise', note: '', wide: true });
    const rResidual = readout('Residual', { unit: '°', note: 'signal B — gyro vs compass' });
    const rFloor = readout('Noise floor', { unit: '°', note: '' });
    const rPeak = readout('Peak index', { unit: '×', note: 'since reset' });

    append(scroll, stateBox,
      section('Detection'), rIndex.node,
      el('div', { class: 'grid' }, rResidual.node, rFloor.node, rPeak.node));

    const scope = autoCanvas();
    const scopeBox = el('div', { class: 'scope', style: 'height:min(28dvh,220px)' }, scope.node);
    const scopeCap = el('div', { class: 'scope__cap', text: '' });
    append(scopeBox, scopeCap);
    append(scroll, scopeBox);

    // --- corroboration ----------------------------------------------------
    const rAcc = readout('Compass accuracy', { unit: '°', note: 'signal A — corroboration only' });
    const rAccDelta = readout('Accuracy shift', { unit: '°', note: 'from the quiet baseline' });
    const rYaw = readout('Yaw rate', { unit: '°/s', note: 'device rotation' });

    append(scroll, section('Corroboration'),
      el('div', { class: 'grid' }, rAcc.node, rAccDelta.node, rYaw.node));

    // --- raw compass ------------------------------------------------------
    const rHeading = readout('Compass heading', { unit: '°', note: 'raw webkitCompassHeading' });
    const rHeadDev = readout('Heading deviation', { unit: '°', note: 'from where the floor was learned' });
    const rHeadPeak = readout('Peak deviation', { unit: '°', note: '' });

    append(scroll, section('Raw compass — is iOS passing anything through?'),
      el('div', { class: 'grid' }, rHeading.node, rHeadDev.node, rHeadPeak.node),
      notice('warn',
        '<strong>Read this first when the index stays flat.</strong> The heading is the last value before iOS\'s sensor fusion hands anything to the browser. ' +
        'If peak deviation stays at zero while a magnet is right against the phone, the disturbance is being rejected upstream of this app and no amount of maths here can recover it — ' +
        'check Apple\'s own Compass app to confirm, since it reads the same fused source. ' +
        'If the heading <em>does</em> move but the index does not, that is a bug here and worth reporting.'));

    // --- controls ----------------------------------------------------------
    const btnReset = el('button', { class: 'btn', type: 'button' }, 'Re-learn noise floor');
    btnReset.addEventListener('click', () => { resetFilters(); this.reset(); });
    const btnClear = el('button', { class: 'btn btn--alt', type: 'button' }, 'Clear events');
    btnClear.addEventListener('click', () => { this.events = []; this.peakIndex = 0; renderEvents(); });

    append(scroll, el('div', { class: 'btn-row' }, btnReset, btnClear));

    // --- event log --------------------------------------------------------
    const eventBox = el('div');
    const renderEvents = () => {
      clear(eventBox);
      if (!this.events.length) {
        append(eventBox, el('div', { class: 'dim mono', style: 'font-size:11px', text: 'No anomalies detected yet.' }));
        return;
      }
      const t = el('table', { class: 'dtable' });
      const body = el('tbody');
      append(body, el('tr', {},
        el('td', { text: 'when' }),
        el('td', { text: 'duration', style: 'text-align:right' }),
        el('td', { text: 'peak', style: 'text-align:right' })));
      for (const ev of [...this.events].reverse().slice(0, 8)) {
        append(body, el('tr', { 'data-state': ev.peak > 40 ? 'bad' : 'warn' },
          el('td', { text: `t+${ev.start.toFixed(1)} s` }),
          el('td', { text: `${(ev.end - ev.start).toFixed(1)} s`, style: 'text-align:right' }),
          el('td', { text: `${ev.peak.toFixed(0)}×`, style: 'text-align:right' })));
      }
      append(t, body);
      append(eventBox, t);
    };
    append(scroll, notice('warn',
      '<strong>What sets this off.</strong> Ferrous mass and permanent magnets: speakers, laptop lids and hinges, motors, steel furniture and structural steel, magnetic mounts. ' +
      'It is most sensitive with the phone resting still — then the gyroscope predicts no heading change at all, and anything the compass reports is disturbance. Moving the phone raises the floor because gyro integration error enters the comparison.'));

    append(scroll, section('Events'), eventBox);
    renderEvents();

    // --- stream -----------------------------------------------------------
    let lastT = 0;
    this.sub(residual, (s) => {
      this.sample = s;
      const dt = lastT === 0 ? 1 / 60 : Math.min(Math.max(s.t - lastT, 1e-4), 0.5);
      lastT = s.t;

      // Own bias tracker, on the RAW residual, so it can be frozen while
      // triggered. See BIAS_TAU.
      if (!this.biasPrimed) { this.bias = s.residualRaw; this.biasPrimed = true; }
      const corrected = s.residualRaw - this.bias;

      // Learn the floor from the first quiet seconds, then keep tracking it
      // during quiet, freezing while an event is in progress so the anomaly
      // cannot raise the very floor it is measured against.
      if (this.floor === null) {
        if (this.learnStart === 0) this.learnStart = s.t;
        this.learnSum += corrected * corrected;
        this.learnCount++;
        this.bias += (s.residualRaw - this.bias) * (1 - Math.exp(-dt / BIAS_TAU));
        if (s.t - this.learnStart >= LEARN_S && this.learnCount > 30) {
          this.floor = Math.max(Math.sqrt(this.learnSum / this.learnCount), MIN_FLOOR);
          this.baseAccuracy = s.accuracy;
        }
        return;
      }

      this.corrected = corrected;
      this.index = Math.abs(corrected) / this.floor;
      if (this.index > this.peakIndex) this.peakIndex = this.index;

      // Both trackers freeze together while triggered.
      if (this.index < FLOOR_FREEZE_SIGMA) {
        this.floor = Math.max(MIN_FLOOR,
          this.floor + (Math.abs(corrected) - this.floor) * (1 - Math.exp(-dt / FLOOR_TAU)));
        this.bias += (s.residualRaw - this.bias) * (1 - Math.exp(-dt / BIAS_TAU));
      }

      // Event bookkeeping.
      if (this.index >= ALERT_SIGMA) {
        if (!this.inEvent) this.inEvent = { start: s.t, end: s.t, peak: this.index, peakAcc: s.accuracy ?? 0 };
        this.inEvent.end = s.t;
        this.inEvent.peak = Math.max(this.inEvent.peak, this.index);
        this.inEvent.peakAcc = Math.max(this.inEvent.peakAcc, s.accuracy ?? 0);
      } else if (this.inEvent && s.t - this.inEvent.end > 0.75) {
        // Only log events that lasted long enough to be real.
        if (this.inEvent.end - this.inEvent.start > 0.15) {
          this.events.push(this.inEvent);
          if (this.events.length > 50) this.events.shift();
          renderEvents();
        }
        this.inEvent = null;
      }

      // Raw heading tracking, independent of the residual chain.
      if (s.heading !== null) {
        if (s.heading !== this.lastHeadingValue) {
          if (this.lastHeadingValue !== null) this.headingChanges++;
          this.lastHeadingValue = s.heading;
          this.lastHeadingChangeAt = s.t;
        }
        if (this.headingRef === null) this.headingRef = s.heading;
        this.headingDev = angleDelta(s.heading, this.headingRef);
        this.headingPeakDev = Math.max(this.headingPeakDev, Math.abs(this.headingDev));
      }

      this.trace.push({ index: this.index, acc: s.accuracy ?? 0 });
      if (this.trace.length > TRACE_N) this.trace.shift();
    });

    // --- render -----------------------------------------------------------
    let lastState = '';
    this.loop(() => {
      scope.resize();
      const s = this.sample;

      // A ladder, not a boolean. Each rung is a different failure with a
      // different remedy, and collapsing them loses exactly the information
      // the user needs. In particular "accuracy was never reported" is NOT
      // the same as "accuracy is good" — conflating the two is how a gate
      // designed to catch an uncalibrated compass ends up showing green while
      // knowing nothing.
      const orientDead = s !== null && s.orientAgeMs > 2000;
      const accUnknown = s !== null && s.accuracy === null;
      const accInvalid = s !== null && s.accuracy !== null && s.accuracy < 0;
      const accTooHigh = s !== null && s.accuracy !== null && s.accuracy > MAX_USABLE_ACCURACY;
      const usable = s !== null && !orientDead && !accUnknown && !accInvalid && !accTooHigh;
      const learning = this.floor === null;
      const state =
          !s          ? 'nodata'
        : orientDead  ? 'noevents'
        : accUnknown  ? 'noaccuracy'
        : accInvalid  ? 'invalid'
        : accTooHigh  ? 'uncal'
        : learning    ? 'learning'
        : 'ready';

      if (state !== lastState) {
        lastState = state;
        clear(stateBox);
        if (state === 'nodata') {
          append(stateBox, notice('bad', '<strong>No orientation data.</strong> Check the motion permission was granted, and that Settings → Safari → Motion &amp; Orientation Access is on — that one WebKit toggle governs Chrome and Edge too.'));
        } else if (state === 'noevents') {
          append(stateBox, notice('bad',
            '<strong>No orientation events are arriving — index suppressed.</strong> The heading is frozen because nothing is updating it, not because the field is quiet. ' +
            'Check the orientation permission was granted, and that Settings → Safari → Motion &amp; Orientation Access is on. Leaving and re-entering this screen re-subscribes from scratch.'));
        } else if (state === 'noaccuracy') {
          append(stateBox, notice('bad',
            '<strong>Heading accuracy is not being reported — index suppressed.</strong> Orientation events are arriving, but <code>webkitCompassAccuracy</code> is absent, so there is no way to tell a calibrated compass from a wildly drifting one. ' +
            'That value comes from Core Location, so the usual cause is that <strong>Location Services is off for this browser</strong> — check Settings → Privacy &amp; Security → Location Services, and the site\'s own location permission. ' +
            'The index is suppressed rather than shown, because an uncalibrated compass invents anomalies far larger than any real one.'));
        } else if (state === 'invalid') {
          append(stateBox, notice('bad',
            '<strong>iOS reports the heading as invalid — index suppressed.</strong> A negative <code>webkitCompassAccuracy</code> means the compass needs calibrating. Wave the phone in a figure-eight through all three axes for ten to fifteen seconds.'));
        } else if (state === 'uncal') {
          append(stateBox, notice('bad',
            `<strong>Compass not calibrated — index suppressed.</strong> Wave the phone in a figure-eight through all three axes for ten to fifteen seconds. ` +
            `Above ${MAX_USABLE_ACCURACY}° of heading error the compass wanders on its own by more than a magnet moves it, so any index would be measuring the compass rather than the field.`));
        } else if (state === 'learning') {
          append(stateBox, notice('warn', `<strong>Learning the noise floor.</strong> Hold still and keep magnets away for ${LEARN_S} seconds. The index is expressed in multiples of this, so it has to be measured before anything can be reported.`));
        } else {
          append(stateBox, notice('ok', '<strong>Ready.</strong> The index reads the disagreement between gyroscope and compass, in multiples of the floor just measured. Bring something ferrous near the top of the phone.'));
        }
      }

      if (!usable || learning || !s) {
        const why =
            state === 'noevents'   ? 'no orientation events'
          : state === 'noaccuracy' ? 'heading accuracy not reported'
          : state === 'invalid'    ? 'iOS reports heading invalid'
          : state === 'uncal'      ? 'compass not calibrated'
          : state === 'learning'   ? 'learning noise floor…'
          : 'no data';
        rIndex.set('—', why);
        rIndex.setState('idle');
        rResidual.set(s ? fmt(s.residualRaw - this.bias, 3) : '—');
        rFloor.set(this.floor === null ? '—' : fmt(this.floor, 4), this.floor === null ? 'measuring' : '');
      } else {
        const alert = this.index >= ALERT_SIGMA;
        rIndex.set(this.index < 1000 ? fmt(this.index, 1) : '999+',
          alert ? `ANOMALY — ${fmt(Math.abs(this.corrected), 2)}° of unexplained heading` : 'quiet');
        rIndex.setState(alert ? 'bad' : this.index >= FLOOR_FREEZE_SIGMA ? 'warn' : 'ok');
        rResidual.set(fmt(this.corrected, 3), `raw ${fmt(s.residualRaw, 3)}° · bias ${fmt(this.bias, 3)}°`);
        rResidual.setState(alert ? 'bad' : 'ok');
        rFloor.set(fmt(this.floor!, 4), `alert at ${ALERT_SIGMA}× = ${fmt(this.floor! * ALERT_SIGMA, 3)}°`);
        rFloor.setState('ok');
      }

      // Raw compass readouts — deliberately outside the readiness gate, because
      // when the gate is closed these are the numbers that explain why.
      if (s && s.heading !== null) {
        const sinceChange = s.t - this.lastHeadingChangeAt;
        rHeading.set(fmt(s.heading, 1),
          `${this.headingChanges} updates · last ${sinceChange < 60 ? `${fmt(sinceChange, 1)} s ago` : 'a while ago'}`);
        rHeading.setState(this.headingChanges > 0 ? 'ok' : 'warn');
        rHeadDev.set(this.headingRef === null ? '—' : fmt(this.headingDev, 1),
          this.headingRef === null ? 'no reference yet' : `reference ${fmt(this.headingRef, 1)}°`);
        rHeadPeak.set(fmt(this.headingPeakDev, 1),
          this.headingPeakDev > 5 ? 'the compass IS seeing something'
          : this.headingPeakDev > 1 ? 'small movement only'
          : 'NOTHING — iOS is passing no disturbance through');
        rHeadPeak.setState(this.headingPeakDev > 5 ? 'ok' : this.headingPeakDev > 1 ? 'warn' : 'bad');
      } else {
        rHeading.set('—', 'webkitCompassHeading absent');
        rHeading.setState('bad');
        rHeadDev.set('—');
        rHeadPeak.set('—');
      }

      rPeak.set(this.peakIndex > 0 ? fmt(this.peakIndex, 0) : '—');
      rPeak.setState(this.peakIndex >= ALERT_SIGMA ? 'warn' : 'idle');

      if (s) {
        rAcc.set(
          s.accuracy === null ? 'NOT REPORTED' : s.accuracy < 0 ? 'INVALID' : fmt(s.accuracy, 0),
          s.accuracy === null ? 'webkitCompassAccuracy absent — check Location Services'
            : s.accuracy < 0 ? 'negative — heading not valid'
            : usable ? 'good' : `above ${MAX_USABLE_ACCURACY}° limit`);
        rAcc.setState(s.accuracy === null || s.accuracy < 0 || !usable ? 'bad' : 'ok');
        const dAcc = this.baseAccuracy === null || s.accuracy === null ? null : s.accuracy - this.baseAccuracy;
        rAccDelta.set(dAcc === null ? '—' : `${dAcc >= 0 ? '+' : ''}${fmt(dAcc, 1)}`,
          dAcc === null ? 'no baseline yet' : dAcc >= 10 ? 'signal A agrees' : 'signal A quiet');
        rAccDelta.setState(dAcc !== null && dAcc >= 10 ? 'warn' : 'idle');
        rYaw.set(fmt(s.yawRate, 1),
          `${Math.abs(s.yawRate) > 5 ? 'moving — floor is raised' : 'still'} · orientation ${fmt(s.orientHz, 0)} Hz`);
        rYaw.setState(Math.abs(s.yawRate) > 15 ? 'warn' : 'ok');
      }

      scopeCap.textContent = this.floor === null
        ? 'LEARNING'
        : `INDEX · ALERT AT ${ALERT_SIGMA}×`;
      this.drawScope(scope);
    });
  }

  private reset(): void {
    this.floor = null;
    this.bias = 0;
    this.biasPrimed = false;
    this.corrected = 0;
    this.learnStart = 0;
    this.learnSum = 0;
    this.learnCount = 0;
    this.index = 0;
    this.peakIndex = 0;
    this.baseAccuracy = null;
    this.headingRef = null;
    this.headingDev = 0;
    this.headingPeakDev = 0;
    this.headingChanges = 0;
    this.lastHeadingValue = null;
    this.trace = [];
    this.inEvent = null;
  }

  /** Log-scaled, because the index spans three orders of magnitude. */
  private drawScope(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    if (this.trace.length < 2) {
      ctx.fillStyle = col.gridMid;
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.floor === null ? 'LEARNING NOISE FLOOR' : 'AWAITING DATA', w / 2, h / 2);
      return;
    }

    const MAX = 1000;
    const yOf = (v: number) => {
      const t = Math.log10(Math.max(v, 0.5) / 0.5) / Math.log10(MAX / 0.5);
      return h - 14 - t * (h - 22);
    };

    // Decade gridlines and the alert threshold.
    ctx.font = "9px ui-monospace, monospace";
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const v of [1, 10, 100, 1000]) {
      const y = yOf(v);
      ctx.strokeStyle = col.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(26, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = col.gridMid;
      ctx.fillText(`${v}×`, 3, y);
    }
    const ay = yOf(ALERT_SIGMA);
    ctx.strokeStyle = alpha(col.bad, 0.67);
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(26, ay); ctx.lineTo(w, ay); ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    for (let i = 0; i < this.trace.length; i++) {
      const x = 26 + (i / (TRACE_N - 1)) * (w - 26);
      const y = yOf(this.trace[i].index);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = col.trace[0];
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Signal A, on its own scale, as a faint overlay.
    ctx.beginPath();
    for (let i = 0; i < this.trace.length; i++) {
      const x = 26 + (i / (TRACE_N - 1)) * (w - 26);
      const y = h - 14 - (Math.min(this.trace[i].acc, 90) / 90) * (h - 22);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = alpha(col.trace[1], 0.4);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = col.light1T;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('▬ index', w - 60, 5);
    ctx.fillStyle = alpha(col.light2T, 0.6);
    ctx.fillText('▬ accuracy', w - 4, 5);
  }
}
