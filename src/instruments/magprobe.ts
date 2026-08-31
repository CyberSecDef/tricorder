/**
 * §11 q.2 — measurement harness for the gyro/compass residual.
 *
 * This is NOT Instrument 7. It is the experiment that decides whether
 * Instrument 7's signal B is possible at all. The handoff is explicit: iOS
 * Core Motion already fuses gyro and magnetometer and may reject magnetic
 * outliers, which would damp the residual to nothing. "Measure this before
 * building UI around it — sweep the phone past a speaker magnet and log the
 * raw residual. If signal B turns out to be too smoothed, fall back to signal
 * A alone."
 *
 * A live wiggling trace cannot answer that. What answers it is a paired
 * comparison: record the same sweep twice, once clean and once past a magnet,
 * and see whether the disturbed run separates from the clean one by more than
 * the clean run's own noise. So this screen records two runs and reports the
 * numbers, plus a verdict with its thresholds stated.
 *
 * Signal A (webkitCompassAccuracy) is recorded alongside, because it is the
 * fallback if B is dead, and it costs nothing to capture.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, clear } from '../ui/dom';
import { motion } from '../sensors/motion';
import { orientation } from '../sensors/orientation';
import { gravity } from '../sensors/gravity';
import { dot, angleDelta, type Vec3 } from '../lib/vec';
import * as storage from '../lib/storage';

/** Sliding window over which predicted and actual heading change are compared. */
const WINDOW_S = 1.5;
/** Detrend time constant for gyro bias (§8.7 step 6 suggests 20–30 s). */
const DETREND_TAU = 25;
/** Rotation below this is not a sweep; the residual would be meaningless. */
const MIN_SWEEP_DEG = 90;
/** A run must be at least this long to be worth comparing. */
const MIN_RUN_S = 4;

interface Sample {
  t: number;            // seconds since run start
  residual: number;     // degrees, detrended
  residualRaw: number;  // degrees, before detrending
  accuracy: number;     // webkitCompassAccuracy, degrees (negative = invalid)
  yawRate: number;      // deg/s about true vertical
  rotated: number;      // cumulative |rotation| in the run, degrees
}

interface RunStats {
  samples: number;
  duration: number;
  rotated: number;
  residualRms: number;
  residualPeak: number;
  residualP95: number;
  accuracyMean: number;
  accuracyMax: number;
  accuracyInvalidFraction: number;
}

interface Run { label: string; stats: RunStats; data: Sample[] }

type Slot = 'baseline' | 'disturbed';

export class MagProbeInstrument extends Instrument {
  readonly id = 'magprobe';
  readonly title = 'Magnetic Residual Probe';
  override readonly subtitle = '§11 q.2 — is signal B alive?';
  override readonly resources = 'orientation + motion';

  // --- live state -------------------------------------------------------
  private gDown: Vec3 | null = null;
  private heading: number | null = null;
  private prevHeading: number | null = null;
  private accuracy = 0;

  /** Sliding window of per-sample (predicted, actual) heading increments. */
  private win: Array<{ t: number; pred: number; act: number }> = [];
  private clock = 0;

  private residualRaw = 0;
  private residual = 0;
  private detrend = 0;
  private detrendPrimed = false;
  private yawRate = 0;

  /**
   * Sign relating yaw rate about ĝ_down to increasing compass heading. §8.7
   * says "sign per your empirical convention" — rather than guess, we estimate
   * it from the data by accumulating the correlation between predicted and
   * actual heading change, and persist the answer.
   */
  private sign: 1 | -1 = storage.load<1 | -1>('magprobe:sign', 1);
  private signEvidence = storage.load<number>('magprobe:signEvidence', 0);

  // --- recording --------------------------------------------------------
  private recording: Slot | null = null;
  private buffer: Sample[] = [];
  private runStart = 0;
  private rotated = 0;
  private runs: Partial<Record<Slot, Run>> = {};

  private trace: Sample[] = [];   // rolling live trace, independent of runs

  /**
   * Static magnet test. The residual only exists when the phone rotates, so a
   * null result from a sweep is ambiguous: it could mean Core Motion rejected
   * the disturbance, or that the magnet never reached the magnetometer at all.
   * Marking a reference heading and watching raw deviation separates those —
   * it needs no rotation and no fusion, just the compass output itself.
   */
  private refHeading: number | null = null;
  private deviation = 0;
  private peakDeviation = 0;
  private refAccuracy = 0;
  private peakAccuracy = 0;

  protected build(root: HTMLElement): void {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    append(scroll, notice('warn',
      '<strong>This is an experiment, not an instrument.</strong> It exists to answer one question: does Core Motion\'s sensor fusion damp the gyro/compass residual so hard that Instrument 7\'s signal B is unusable? ' +
      'Record a <em>baseline</em> sweep with no ferrous mass nearby, then a <em>disturbed</em> sweep past a speaker magnet, fridge magnet or laptop. Same motion both times. The verdict compares them.'));

    // --- live readouts ---------------------------------------------------
    const rResidual = readout('Residual', { unit: '°', note: 'detrended, 1.5 s window' });
    const rRaw = readout('Residual (raw)', { unit: '°', note: 'before bias detrend' });
    const rYaw = readout('Yaw rate', { unit: '°/s', note: 'about true vertical' });
    const rAcc = readout('Compass accuracy', { unit: '°', note: 'signal A — negative = invalid' });
    const rSign = readout('Yaw sign', { note: '' });
    const rRot = readout('Rotation this run', { unit: '°', note: '' });

    append(scroll, section('Live'),
      el('div', { class: 'grid' }, rResidual.node, rRaw.node, rYaw.node),
      el('div', { class: 'grid' }, rAcc.node, rSign.node, rRot.node));

    // --- static magnet test ----------------------------------------------
    const rHeadingRaw = readout('Compass heading', { unit: '°', note: 'raw webkitCompassHeading' });
    const rDeviation = readout('Deviation from mark', { unit: '°', note: '' });
    const rPeakDev = readout('Peak deviation', { unit: '°', note: 'since the mark' });

    const btnMark = el('button', { class: 'btn', type: 'button' }, 'Mark reference');
    btnMark.addEventListener('click', () => {
      this.refHeading = this.heading;
      this.refAccuracy = this.accuracy;
      this.peakDeviation = 0;
      this.peakAccuracy = this.accuracy;
    });

    append(scroll,
      section('Static magnet test'),
      notice('warn',
        '<strong>Do this first, and do not rotate the phone.</strong> Lay it flat, press <em>Mark reference</em>, then bring the magnet slowly up to it. ' +
        'The magnetometer sits near the <strong>top of the phone</strong>, so approach that end, and get within a few centimetres — a fridge magnet at arm\'s length proves nothing. ' +
        'If the heading does not move and the accuracy does not degrade, the compass itself never saw the field, and no amount of residual maths will recover a signal that was never there.'),
      notice('ok',
        '<strong>Verify the readout first.</strong> Mark a reference, then physically turn the phone through about 90°. Peak deviation must jump to roughly 90. ' +
        'If it does, this display works and a null result from the magnet is a real measurement. If it stays at zero, the fault is here and not in the physics. Re-mark before the magnet test.'),
      notice('warn',
        '<strong>Not all magnets are usable.</strong> Flexible fridge-door magnets are deliberately multipole — alternating stripes a few millimetres apart — so their field collapses almost immediately and they will not reach the magnetometer. ' +
        'Use a speaker driver (headphones, a Bluetooth speaker), a MagSafe puck or magnetic mount, a laptop lid hinge, or a neodymium magnet. A steel mass such as a cast-iron pan or a large screwdriver also works, by distorting the field rather than adding to it.'),
      el('div', { class: 'grid' }, rHeadingRaw.node, rDeviation.node, rPeakDev.node),
      el('div', { class: 'btn-row' }, btnMark));

    const resScope = autoCanvas();
    const resBox = el('div', { class: 'scope', style: 'height:min(24dvh,180px)' }, resScope.node);
    append(resBox, el('div', { class: 'scope__cap', text: 'RESIDUAL — SIGNAL B' }));

    const accScope = autoCanvas();
    const accBox = el('div', { class: 'scope', style: 'height:min(18dvh,130px)' }, accScope.node);
    append(accBox, el('div', { class: 'scope__cap', text: 'COMPASS ACCURACY — SIGNAL A' }));

    append(scroll, resBox, accBox);

    // --- recording controls ----------------------------------------------
    const btnBase = el('button', { class: 'btn', type: 'button' }, 'Record baseline');
    const btnDist = el('button', { class: 'btn btn--alt', type: 'button' }, 'Record disturbed');
    const btnStop = el('button', { class: 'btn btn--warn', type: 'button' }, 'Stop');
    btnStop.disabled = true;
    const btnCopy = el('button', { class: 'btn', type: 'button' }, 'Copy results JSON');
    const recStatus = el('div');

    const startRun = (slot: Slot) => {
      this.recording = slot;
      this.buffer = [];
      this.rotated = 0;
      this.runStart = this.clock;
      btnBase.disabled = btnDist.disabled = true;
      btnStop.disabled = false;
      renderStatus();
    };

    const stopRun = () => {
      const slot = this.recording;
      this.recording = null;
      btnBase.disabled = btnDist.disabled = false;
      btnStop.disabled = true;
      if (slot && this.buffer.length) {
        this.runs[slot] = {
          label: slot,
          stats: summarise(this.buffer),
          data: this.buffer,
        };
        this.buffer = [];
      }
      renderStatus();
      renderVerdict();
    };

    btnBase.addEventListener('click', () => startRun('baseline'));
    btnDist.addEventListener('click', () => startRun('disturbed'));
    btnStop.addEventListener('click', stopRun);
    btnCopy.addEventListener('click', () => void this.copyResults(btnCopy));

    const renderStatus = () => {
      clear(recStatus);
      if (this.recording) {
        append(recStatus, notice('warn',
          `<strong>Recording ${this.recording}.</strong> Rotate the phone smoothly through at least ${MIN_SWEEP_DEG}° of yaw — a sweep with no rotation produces no residual and tells you nothing.`));
      }
    };

    append(scroll, section('Record'),
      el('div', { class: 'btn-row' }, btnBase, btnDist, btnStop),
      recStatus);

    const runTable = el('div');
    const verdict = el('div');
    append(scroll, section('Runs'), runTable, section('Verdict'), verdict,
      el('div', { class: 'btn-row' }, btnCopy));

    const renderVerdict = () => {
      clear(runTable);
      append(runTable, this.renderRuns());
      clear(verdict);
      append(verdict, this.renderVerdict());
    };
    renderVerdict();

    // --- streams ----------------------------------------------------------
    this.sub(gravity, (g) => { this.gDown = g.down; });

    this.sub(orientation, (o) => {
      this.heading = o.heading;
      if (o.headingAccuracy !== null) this.accuracy = o.headingAccuracy;
    });

    // Everything is computed on the motion clock, because that is the stream
    // that carries a trustworthy dt (§7). Heading contributes zero on samples
    // where it did not change, which is correct — the window sums the same
    // total either way.
    this.sub(motion, (m) => {
      if (!m.omega || !this.gDown) return;
      this.clock += m.dt;

      // Project the rotation-rate vector onto the vertical. rotationRate.alpha
      // alone is only yaw when the phone lies flat on its back (§8.7 step 2).
      const yaw = dot(m.omega, this.gDown) * this.sign;
      this.yawRate = yaw;

      let actual = 0;
      if (this.heading !== null) {
        if (this.prevHeading !== null) actual = angleDelta(this.heading, this.prevHeading);
        this.prevHeading = this.heading;
      }

      const pred = yaw * m.dt;
      this.win.push({ t: this.clock, pred, act: actual });
      while (this.win.length && this.clock - this.win[0].t > WINDOW_S) this.win.shift();

      let sumPred = 0, sumAct = 0;
      for (const w of this.win) { sumPred += w.pred; sumAct += w.act; }

      this.residualRaw = sumAct - sumPred;

      // Gyro bias shows up as a slow constant drift in the residual, so
      // subtract a long EMA of it. What survives is the anomaly index.
      const a = 1 - Math.exp(-m.dt / DETREND_TAU);
      if (!this.detrendPrimed) { this.detrend = this.residualRaw; this.detrendPrimed = true; }
      else this.detrend += (this.residualRaw - this.detrend) * a;
      this.residual = this.residualRaw - this.detrend;

      // Sign estimation: if predicted and actual consistently disagree in
      // direction, our convention is backwards. Accumulate evidence rather
      // than flipping on a single noisy sample.
      if (Math.abs(sumPred) > 2) {
        this.signEvidence += Math.sign(sumPred) === Math.sign(sumAct) ? 1 : -1;
        this.signEvidence = Math.max(-400, Math.min(400, this.signEvidence));
        if (this.signEvidence < -60) {
          this.sign = (this.sign === 1 ? -1 : 1);
          this.signEvidence = 0;
          storage.save('magprobe:sign', this.sign);
          this.win.length = 0;
          this.detrendPrimed = false;
        }
        storage.save('magprobe:signEvidence', this.signEvidence);
      }

      this.rotated += Math.abs(yaw) * m.dt;

      const s: Sample = {
        t: this.clock - (this.recording ? this.runStart : 0),
        residual: this.residual,
        residualRaw: this.residualRaw,
        accuracy: this.accuracy,
        yawRate: yaw,
        rotated: this.rotated,
      };

      this.trace.push(s);
      if (this.trace.length > 900) this.trace.shift();   // ~15 s at 60 Hz
      if (this.recording) {
        this.buffer.push(s);
        if (this.buffer.length > 60 * 180) stopRun();     // 3 min hard cap
      }
    });

    // --- render -----------------------------------------------------------
    this.loop(() => {
      resScope.resize();
      accScope.resize();

      rResidual.set(fmt(this.residual, 2));
      rResidual.setState(Math.abs(this.residual) > 4 ? 'bad' : Math.abs(this.residual) > 1.5 ? 'warn' : 'ok');
      rRaw.set(fmt(this.residualRaw, 2), `bias EMA ${fmt(this.detrend, 2)}°`);
      rYaw.set(fmt(this.yawRate, 1));
      rAcc.set(this.accuracy < 0 ? 'INVALID' : fmt(this.accuracy, 0),
        this.accuracy < 0 ? `raw ${fmt(this.accuracy, 0)} — uncalibrated` : 'lower is better');
      rAcc.setState(this.accuracy < 0 ? 'bad' : this.accuracy <= 15 ? 'ok' : this.accuracy <= 35 ? 'warn' : 'bad');
      // Static test readouts.
      rHeadingRaw.set(this.heading === null ? '—' : fmt(this.heading, 1),
        this.refHeading === null ? 'press Mark reference to begin' : `mark ${fmt(this.refHeading, 1)}°`);
      rHeadingRaw.setState(this.heading === null ? 'bad' : 'ok');

      if (this.refHeading !== null && this.heading !== null) {
        this.deviation = angleDelta(this.heading, this.refHeading);
        this.peakDeviation = Math.max(this.peakDeviation, Math.abs(this.deviation));
        this.peakAccuracy = Math.max(this.peakAccuracy, this.accuracy);
        rDeviation.set(fmt(this.deviation, 1), `accuracy ${fmt(this.refAccuracy, 0)}° → ${fmt(this.accuracy, 0)}°`);
        rDeviation.setState(Math.abs(this.deviation) > 5 ? 'ok' : Math.abs(this.deviation) > 1.5 ? 'warn' : 'bad');
        rPeakDev.set(fmt(this.peakDeviation, 1),
          this.peakDeviation > 5
            ? 'compass responds — the field reaches it'
            : this.peakDeviation > 1.5
              ? 'weak response — get the magnet closer'
              : 'NO RESPONSE — compass never saw the field');
        rPeakDev.setState(this.peakDeviation > 5 ? 'ok' : this.peakDeviation > 1.5 ? 'warn' : 'bad');
      } else {
        rDeviation.set('—');
        rDeviation.setState('idle');
        rPeakDev.set('—');
        rPeakDev.setState('idle');
      }

      rSign.set(this.sign > 0 ? '+1' : '−1',
        `auto-estimated · confidence ${Math.min(100, Math.abs(this.signEvidence) / 4).toFixed(0)}%`);
      rSign.setState(Math.abs(this.signEvidence) > 100 ? 'ok' : 'warn');
      rRot.set(this.recording ? fmt(this.rotated - (this.buffer[0]?.rotated ?? this.rotated), 0) : fmt(this.rotated, 0),
        this.recording ? `need ≥ ${MIN_SWEEP_DEG}°` : 'idle');

      this.drawTrace(resScope, (s) => s.residual, '#ffcc66', 'symmetric');
      this.drawTrace(accScope, (s) => s.accuracy, '#cc99ff', 'positive');
    });
  }

  private drawTrace(
    c: ReturnType<typeof autoCanvas>,
    pick: (s: Sample) => number,
    colour: string,
    mode: 'symmetric' | 'positive',
  ): void {
    const { ctx } = c;
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const d = this.trace;
    if (d.length < 2) {
      ctx.fillStyle = '#3a3a48';
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AWAITING MOTION', w / 2, h / 2);
      return;
    }

    let max = mode === 'symmetric' ? 2 : 20;
    for (const s of d) max = Math.max(max, Math.abs(pick(s)));
    max *= 1.15;

    const yOf = mode === 'symmetric'
      ? (v: number) => h / 2 - (v / max) * (h / 2 - 12)
      : (v: number) => h - 12 - (Math.max(v, 0) / max) * (h - 24);

    ctx.strokeStyle = '#1e1e28';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const zero = yOf(0);
    ctx.moveTo(0, zero); ctx.lineTo(w, zero); ctx.stroke();

    ctx.beginPath();
    for (let i = 0; i < d.length; i++) {
      const x = (i / (d.length - 1)) * w;
      const y = yOf(pick(d[i]));
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#9a8f80';
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`±${max.toFixed(1)}°`, 6, 5);
  }

  private renderRuns(): HTMLElement {
    const wrap = el('div');
    const slots: Slot[] = ['baseline', 'disturbed'];
    const t = el('table', { class: 'dtable' });
    const body = el('tbody');

    const row = (k: string, a: string, b: string) => {
      append(body, el('tr', {},
        el('td', { text: k }),
        el('td', { text: a, style: 'text-align:right' }),
        el('td', { text: b, style: 'text-align:right' })));
    };

    row('', 'BASELINE', 'DISTURBED');
    const get = (s: Slot) => this.runs[s]?.stats;
    const f = (s: Slot, pick: (r: RunStats) => number, d = 2) => {
      const r = get(s);
      return r ? pick(r).toFixed(d) : '—';
    };
    row('duration (s)', f('baseline', (r) => r.duration, 1), f('disturbed', (r) => r.duration, 1));
    row('rotation (°)', f('baseline', (r) => r.rotated, 0), f('disturbed', (r) => r.rotated, 0));
    row('residual RMS (°)', f('baseline', (r) => r.residualRms), f('disturbed', (r) => r.residualRms));
    row('residual p95 (°)', f('baseline', (r) => r.residualP95), f('disturbed', (r) => r.residualP95));
    row('residual peak (°)', f('baseline', (r) => r.residualPeak), f('disturbed', (r) => r.residualPeak));
    row('accuracy mean (°)', f('baseline', (r) => r.accuracyMean, 1), f('disturbed', (r) => r.accuracyMean, 1));
    row('accuracy max (°)', f('baseline', (r) => r.accuracyMax, 1), f('disturbed', (r) => r.accuracyMax, 1));
    row('accuracy invalid', f('baseline', (r) => r.accuracyInvalidFraction * 100, 0) + '%',
      f('disturbed', (r) => r.accuracyInvalidFraction * 100, 0) + '%');

    append(t, body);
    append(wrap, t);

    const missing = slots.filter((s) => !this.runs[s]);
    if (missing.length) {
      append(wrap, notice('warn', `Still needed: <strong>${missing.join('</strong> and <strong>')}</strong>.`));
    }
    return wrap;
  }

  /**
   * The verdict. Thresholds are stated rather than hidden, because the whole
   * point of this screen is to produce a defensible answer, and a number the
   * reader cannot check is no better than a guess.
   */
  private renderVerdict(): HTMLElement {
    const b = this.runs.baseline?.stats;
    const d = this.runs.disturbed?.stats;
    if (!b || !d) {
      return notice('warn', 'Record both runs to get a verdict.');
    }

    const problems: string[] = [];
    if (b.rotated < MIN_SWEEP_DEG || d.rotated < MIN_SWEEP_DEG) {
      problems.push(`One or both runs rotated less than ${MIN_SWEEP_DEG}°. Without rotation there is no predicted heading change, so the residual is meaningless.`);
    }
    if (b.duration < MIN_RUN_S || d.duration < MIN_RUN_S) {
      problems.push(`One or both runs are shorter than ${MIN_RUN_S} s.`);
    }
    const rotRatio = Math.max(b.rotated, d.rotated) / Math.max(1, Math.min(b.rotated, d.rotated));
    if (rotRatio > 2) {
      problems.push(`The two runs differ in total rotation by ${rotRatio.toFixed(1)}×. Compare like with like — repeat the same sweep.`);
    }
    if (problems.length) {
      return notice('bad', `<strong>Runs not comparable.</strong><ul>${problems.map((p) => `<li>${p}</li>`).join('')}</ul>`);
    }

    // Signal B: does the disturbed run's residual separate from the clean
    // run's own noise floor? Peak against baseline RMS is the honest test —
    // an anomaly is an excursion, and baseline RMS is what an excursion has
    // to beat to be visible.
    const snrB = d.residualPeak / Math.max(b.residualRms, 0.05);
    const ratioB = d.residualRms / Math.max(b.residualRms, 0.05);
    const bAlive = snrB >= 4 && ratioB >= 1.5;
    const bMarginal = !bAlive && snrB >= 2.5;

    // Signal A: compass accuracy degradation.
    const accDelta = d.accuracyMax - b.accuracyMax;
    const aAlive = accDelta >= 10 || d.accuracyInvalidFraction > b.accuracyInvalidFraction + 0.1;

    const lines = [
      `<li><strong>Signal B</strong> — disturbed peak ${d.residualPeak.toFixed(2)}° against a baseline RMS noise floor of ${b.residualRms.toFixed(2)}° gives an excursion ratio of <strong>${snrB.toFixed(1)}×</strong> (need ≥ 4). RMS ratio ${ratioB.toFixed(2)}× (need ≥ 1.5).</li>`,
      `<li><strong>Signal A</strong> — peak compass accuracy worsened by <strong>${accDelta.toFixed(1)}°</strong> (need ≥ 10°), invalid fraction ${(b.accuracyInvalidFraction * 100).toFixed(0)}% → ${(d.accuracyInvalidFraction * 100).toFixed(0)}%.</li>`,
    ].join('');

    if (bAlive) {
      return notice('ok',
        `<strong>Signal B survives.</strong> Core Motion's fusion is not damping the residual out of existence, so Instrument 7 can be built on it, with signal A as corroboration.<ul>${lines}</ul>`);
    }
    if (bMarginal) {
      return notice('warn',
        `<strong>Signal B is marginal.</strong> There is an excursion but it does not clear the threshold. Repeat with a stronger source and a slower sweep before deciding. If it stays here, build Instrument 7 on signal A and show B only as a secondary trace.<ul>${lines}</ul>`);
    }
    return notice(aAlive ? 'warn' : 'bad',
      `<strong>Signal B looks damped.</strong> The disturbed residual does not separate from the clean run's noise, which is the outcome §8.7 warned about — Core Motion is rejecting the magnetic outliers before we ever see them. ` +
      (aAlive
        ? 'Signal A did respond, so Instrument 7 should be built on <code>webkitCompassAccuracy</code> alone.'
        : 'Neither signal responded. Before concluding, check the source was actually strong enough and close enough — try a speaker magnet at a few centimetres.') +
      `<ul>${lines}</ul>`);
  }

  private async copyResults(btn: HTMLButtonElement): Promise<void> {
    const payload = {
      question: 'iOS Core Motion fusion damping of the gyro/compass residual (handoff §11 q.2)',
      window_s: WINDOW_S,
      detrend_tau_s: DETREND_TAU,
      yaw_sign: this.sign,
      runs: Object.fromEntries(
        Object.entries(this.runs).map(([k, v]) => [k, {
          stats: v!.stats,
          // Decimate to keep the clipboard payload sane.
          series: v!.data.filter((_, i) => i % 3 === 0).map((s) => ({
            t: +s.t.toFixed(3),
            res: +s.residual.toFixed(3),
            raw: +s.residualRaw.toFixed(3),
            acc: +s.accuracy.toFixed(1),
            yaw: +s.yawRate.toFixed(2),
          })),
        }]),
      ),
    };
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload));
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Clipboard blocked';
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  }
}

function summarise(d: Sample[]): RunStats {
  const n = d.length;
  const duration = n ? d[n - 1].t - d[0].t : 0;
  const rotated = n ? d[n - 1].rotated - d[0].rotated : 0;

  let sumSq = 0, peak = 0;
  let accSum = 0, accMax = -Infinity, accInvalid = 0;
  const abs: number[] = [];
  for (const s of d) {
    sumSq += s.residual * s.residual;
    const a = Math.abs(s.residual);
    abs.push(a);
    if (a > peak) peak = a;
    if (s.accuracy < 0) accInvalid++;
    else { accSum += s.accuracy; accMax = Math.max(accMax, s.accuracy); }
  }
  abs.sort((x, y) => x - y);
  const validAcc = n - accInvalid;

  return {
    samples: n,
    duration,
    rotated,
    residualRms: n ? Math.sqrt(sumSq / n) : 0,
    residualPeak: peak,
    residualP95: abs.length ? abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))] : 0,
    accuracyMean: validAcc ? accSum / validAcc : 0,
    accuracyMax: Number.isFinite(accMax) ? accMax : 0,
    accuracyInvalidFraction: n ? accInvalid / n : 0,
  };
}
