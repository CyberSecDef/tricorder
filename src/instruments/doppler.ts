/**
 * Instrument 8 — Ultrasonic Doppler motion detector (§8.8).
 *
 * Emit a steady tone above hearing, and watch for the sidebands that moving
 * objects scatter back. A reflector approaching at v shifts the return by
 * Δf = 2·v·f/c; at 20 kHz with c = 343 m/s, 1 m/s gives ≈ 117 Hz, which is
 * about 40 bins at fftSize 16384. Easily resolvable.
 *
 * MEASURED (§11 q.3): the reference device runs at 48 kHz, Nyquist 24 kHz, so
 * the carrier sits at 20 kHz with the whole band available. The narrowed
 * 44.1 kHz variant the handoff hedged for is not needed here — but the rate is
 * still read at runtime, because it belongs to the hardware and the active
 * audio route rather than to this app. Plugging in headphones can change it.
 *
 * Three traps, all known in advance and all handled below:
 *
 *   1. The `raw` mic profile is MANDATORY (§5). Noise suppression treats a
 *      steady 20 kHz tone as noise and deletes the carrier outright, and AGC
 *      rescales the very amplitude the motion index is built on.
 *   2. WebKit only pulls an audio graph that reaches the destination (§0.7).
 *      The emit path gets there on its own; the analysis path does not, and
 *      would silently return -Infinity forever.
 *   3. The hardware mute switch silences Web Audio output on iOS. The tone
 *      plays, nothing leaves the speaker, and the display sits at zero looking
 *      exactly like a quiet room. Detected explicitly below.
 *
 * What this does NOT do: detect breathing or heartbeat. Those shifts are
 * sub-Hz and buried in carrier leakage. Nothing in this UI implies otherwise.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireMic, profileApplied, AudioUnavailableError, type MicHandle } from '../sensors/audio';
import { theme, alpha } from '../ui/theme';

/** Target carrier. Clamped below Nyquist at runtime. */
const CARRIER_HZ = 20000;
const FFT_SIZE = 16384;
/**
 * Bins this close to the carrier are excluded. The speaker is centimetres from
 * the microphone, so direct coupling dominates everything, and the analyser's
 * own window has skirts. 30 Hz corresponds to about 0.26 m/s — slower motion
 * than that is simply not detectable this way, and pretending otherwise would
 * just be reporting leakage.
 */
const GUARD_HZ = 30;
/** Outer edge of the analysis band. 600 Hz ≈ 5.1 m/s, well beyond human speed. */
const BAND_HZ = 600;
/**
 * Headroom the carrier needs below Nyquist, in Hz.
 *
 * Not arbitrary: above the carrier we read the analysis band (BAND_HZ), then a
 * 100 Hz gap, then a 400 Hz out-of-band noise reference — so roughly 1.1 kHz
 * has to exist above the carrier before anything is clipped. An earlier
 * version reserved only 2 kHz, which is fine at 48 kHz but leaves just 50 Hz
 * of usable headroom at 44.1 kHz: the upper sideband and the entire noise
 * reference would have run past Nyquist, silently biasing the reference low
 * and the SNR high. Derived from the bands rather than guessed.
 */
const NYQUIST_MARGIN_HZ = BAND_HZ + 100 + 400 + 500;
/** Seconds of quiet used to learn the sideband floor. */
const LEARN_S = 3;
/** Index at which we call it motion. */
const ALERT_SIGMA = 6;
/** The floor tracks quiet only; above this multiple it freezes. */
const FLOOR_FREEZE_SIGMA = 3;
const FLOOR_TAU = 20;
const TRACE_N = 600;
const FLOOR_DB = -140;
/**
 * How far the carrier must stand above the out-of-band noise to count as
 * present, in dB.
 *
 * An ABSOLUTE threshold does not work here. A quiet room at 20 kHz sits
 * extremely low, so any fixed dBFS bar generous enough to accept a real
 * carrier also accepts silence — in testing, pure noise at -101 dBFS sailed
 * past a -115 dBFS bar and the instrument cheerfully began learning a floor
 * from nothing. Measuring the carrier against the noise on either side of the
 * analysis band is self-calibrating: it holds regardless of emitter level,
 * media volume, room, or how reflective the surroundings happen to be.
 *
 * The speaker sits centimetres from the microphone, so a carrier that is
 * genuinely leaving the phone is enormous — tens of dB clear. Anything
 * marginal means it is not getting out.
 */
const CARRIER_SNR_DB = 20;

/** Doppler shift for a reflector closing at v, in Hz. */
const shiftFor = (v: number, carrier: number) => (2 * v * carrier) / 343;

export class DopplerInstrument extends Instrument {
  readonly id = 'doppler';
  readonly title = 'Ultrasonic Doppler';
  override readonly subtitle = 'Motion via sideband energy';
  override readonly resources = 'microphone (raw) + speaker';

  private mic: MicHandle | null = null;
  private analyser: AnalyserNode | null = null;
  private osc: OscillatorNode | null = null;
  private emitGain: GainNode | null = null;
  private bins: Float32Array = new Float32Array(0);

  private sampleRate = 48000;
  private binHz = 0;
  private carrierHz = CARRIER_HZ;
  private carrierBin = 0;
  private emitting = false;
  private level = 0.06;

  private carrierDb = FLOOR_DB;
  private noiseDb = FLOOR_DB;
  private carrierSnr = 0;
  private upper = 0;
  private lower = 0;
  private ratio = 0;
  private floor: number | null = null;
  private learnStart = 0;
  private learnSum = 0;
  private learnCount = 0;
  private index = 0;
  private peakIndex = 0;
  private asymmetry = 0;
  private trace: number[] = [];
  /** Held rather than looked up: a querySelector('.btn') would find whichever
   *  button happens to be first in the DOM, which is a trap waiting for the
   *  next person who adds a button above it. */
  private btnEmit: HTMLButtonElement | null = null;

  protected async build(root: HTMLElement): Promise<void> {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    const statusBox = el('div');

    append(scroll,
      notice('warn',
        '<strong>This emits a continuous 20 kHz tone while it runs.</strong> Most adults cannot hear it; some people, many children and most animals can. ' +
        'It stops the moment you leave this screen.'),
      statusBox);

    try {
      this.mic = await acquireMic('raw');
    } catch (e) {
      append(statusBox, notice('bad', micErrorHtml(e as AudioUnavailableError)));
      return;
    }
    if (!this.isMounted) { this.mic.release(); return; }
    this.onCleanup(() => this.mic?.release());

    const ctx = this.mic.ctx;
    this.sampleRate = ctx.sampleRate;
    // Keep the carrier clear of Nyquist. At 44.1 kHz this lands near 18 kHz.
    this.carrierHz = Math.min(CARRIER_HZ, this.sampleRate / 2 - NYQUIST_MARGIN_HZ);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.3;   // steady enough to read, fast enough to catch a wave
    analyser.minDecibels = FLOOR_DB;
    analyser.maxDecibels = 0;
    this.mic.source.connect(analyser);

    // §0.7 — the analysis path must terminate at the destination or WebKit
    // never feeds it. Zero gain, so nothing is emitted down this branch and
    // there is no microphone-to-speaker loop.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    analyser.connect(sink);
    sink.connect(ctx.destination);

    this.analyser = analyser;
    this.binHz = this.sampleRate / FFT_SIZE;
    this.carrierBin = Math.round(this.carrierHz / this.binHz);
    this.bins = new Float32Array(analyser.frequencyBinCount);
    this.onCleanup(() => {
      for (const n of [analyser, sink]) { try { n.disconnect(); } catch { /* gone */ } }
    });

    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* surfaced below */ } }

    if (!profileApplied(this.mic.settings, 'raw')) {
      append(statusBox, notice('bad',
        '<strong>Raw mic profile not fully applied — this instrument will not work.</strong> The browser kept part of its voice DSP chain. ' +
        'Noise suppression treats a steady 20 kHz tone as noise and removes the carrier entirely, and automatic gain control rescales the amplitude the index is built on.'));
    }

    // --- emit control -----------------------------------------------------
    const btnEmit = el('button', { class: 'btn', type: 'button' }, 'Start emitting');
    this.btnEmit = btnEmit;
    btnEmit.addEventListener('click', () => this.emitting ? this.stopEmit() : this.startEmit(ctx));
    this.onCleanup(() => this.stopEmit());

    const levelInput = el('input', {
      type: 'range', min: '0.01', max: '0.25', step: '0.01',
      value: String(this.level), class: 'rf__input', style: 'width:150px;padding:0',
    }) as HTMLInputElement;
    levelInput.addEventListener('input', () => {
      this.level = parseFloat(levelInput.value);
      if (this.emitGain) this.emitGain.gain.value = this.level;
    });

    append(scroll,
      section('Emitter'),
      el('div', { class: 'rf__row' }, btnEmit,
        el('label', { class: 'rf__label', text: 'Level' }), levelInput));

    // --- readouts ---------------------------------------------------------
    const rIndex = readout('Motion index', { unit: '× quiet', note: '', wide: true });
    const rDir = readout('Direction', { note: 'sideband asymmetry' });
    const rSpeed = readout('Dominant shift', { unit: 'Hz', note: '' });
    const rPeak = readout('Peak index', { unit: '×', note: 'since reset' });

    const rCarrier = readout('Carrier', { unit: 'dBFS', note: '' });
    const rUpper = readout('Upper sideband', { unit: 'dB rel.', note: 'approaching' });
    const rLower = readout('Lower sideband', { unit: 'dB rel.', note: 'receding' });
    const rFloor = readout('Quiet floor', { note: '' });

    append(scroll,
      section('Detection'), rIndex.node,
      el('div', { class: 'grid' }, rDir.node, rSpeed.node, rPeak.node));

    const spec = autoCanvas();
    const specBox = el('div', { class: 'scope', style: 'height:min(26dvh,200px)' }, spec.node);
    const specCap = el('div', { class: 'scope__cap', text: '' });
    append(specBox, specCap);

    const traceC = autoCanvas();
    const traceBox = el('div', { class: 'scope', style: 'height:min(18dvh,140px)' }, traceC.node);
    append(traceBox, el('div', { class: 'scope__cap', text: 'MOTION INDEX' }));

    append(scroll, specBox, traceBox,
      section('Signal'),
      el('div', { class: 'grid' }, rCarrier.node, rUpper.node, rLower.node, rFloor.node));

    const btnReset = el('button', { class: 'btn btn--alt', type: 'button' }, 'Re-learn quiet floor');
    btnReset.addEventListener('click', () => this.resetFloor());
    append(scroll, el('div', { class: 'btn-row' }, btnReset));

    append(scroll, notice('warn',
      '<strong>What this detects, and what it does not.</strong> Gross body movement at close range — a hand waved nearby, someone walking past, a door swinging. ' +
      `The guard band excludes shifts under ${GUARD_HZ} Hz, which is motion slower than about ${fmt(GUARD_HZ * 343 / (2 * this.carrierHz), 2)} m/s, because below that the return is buried in the speaker-to-microphone leakage that dominates everything. ` +
      '<strong>It does not detect breathing or heartbeat.</strong> Those shifts are sub-Hz and sit inside that leakage, and no amount of processing here recovers them. Nothing in this instrument should ever be read as detecting a still person.'));

    // --- render -----------------------------------------------------------
    let lastState = '';
    this.loop((dt) => {
      spec.resize();
      traceC.resize();
      const a = this.analyser;
      if (!a) return;

      a.getFloatFrequencyData(this.bins as Float32Array<ArrayBuffer>);
      this.measure(dt);

      const carrierPresent = this.carrierSnr >= CARRIER_SNR_DB;
      const state = !this.emitting ? 'idle'
        : !carrierPresent ? 'nocarrier'
        : this.floor === null ? 'learning'
        : 'ready';

      if (state !== lastState) {
        lastState = state;
        clear(statusBox);
        if (state === 'idle') {
          append(statusBox, notice('warn', '<strong>Emitter is off.</strong> Press <em>Start emitting</em>. Nothing can be detected without the carrier.'));
        } else if (state === 'nocarrier') {
          append(statusBox, notice('bad',
            `<strong>The microphone cannot hear the carrier.</strong> The tone is playing, but at the emit frequency the microphone is only ${fmt(this.carrierSnr, 0)} dB above the surrounding noise and it needs ${CARRIER_SNR_DB}. The speaker is centimetres from the mic, so a carrier that is actually leaving the phone is unmissable — something is stopping it.` +
            '<ul>' +
            '<li><strong>Check the hardware mute switch.</strong> On iOS it silences Web Audio output entirely. This is the usual cause.</li>' +
            '<li>Turn the media volume up, and the emitter level above.</li>' +
            '<li>If headphones or a Bluetooth speaker are connected, the tone is going there instead.</li>' +
            '</ul>'));
        } else if (state === 'learning') {
          append(statusBox, notice('warn', `<strong>Learning the quiet floor.</strong> Keep still and keep the area clear for ${LEARN_S} seconds. The index is a multiple of this, so it has to be measured first.`));
        } else {
          append(statusBox, notice('ok', '<strong>Running.</strong> Wave a hand near the phone, or walk past it.'));
        }
      }

      const alert = this.index >= ALERT_SIGMA;
      if (this.floor !== null && carrierPresent && this.emitting) {
        rIndex.set(this.index < 1000 ? fmt(this.index, 1) : '999+', alert ? 'MOTION' : 'quiet');
        rIndex.setState(alert ? 'bad' : this.index >= FLOOR_FREEZE_SIGMA ? 'warn' : 'ok');
      } else {
        rIndex.set('—', state === 'idle' ? 'emitter off' : state === 'nocarrier' ? 'no carrier — check the mute switch' : 'learning…');
        rIndex.setState('idle');
      }

      const strong = Math.abs(this.asymmetry) > 0.15 && alert;
      rDir.set(!alert ? '—' : strong ? (this.asymmetry > 0 ? 'APPROACHING' : 'RECEDING') : 'MIXED',
        alert ? `asymmetry ${this.asymmetry >= 0 ? '+' : ''}${fmt(this.asymmetry, 2)}` : 'no motion');
      rDir.setState(!alert ? 'idle' : strong ? 'ok' : 'warn');

      const domHz = this.dominantShift();
      rSpeed.set(alert && domHz ? fmt(Math.abs(domHz), 0) : '—',
        alert && domHz ? `≈ ${fmt(Math.abs(domHz) * 343 / (2 * this.carrierHz), 2)} m/s` : '');
      rPeak.set(this.peakIndex > 0 ? fmt(this.peakIndex, 0) : '—');

      rCarrier.set(fmt(this.carrierDb, 1),
        `${fmt(this.carrierSnr, 0)} dB over noise · need ${CARRIER_SNR_DB} · ${fmt(this.carrierHz / 1000, 1)} kHz`);
      rCarrier.setState(carrierPresent ? 'ok' : this.emitting ? 'bad' : 'idle');
      rUpper.set(fmt(10 * Math.log10(Math.max(this.upper, 1e-20)) - this.carrierDb, 1));
      rLower.set(fmt(10 * Math.log10(Math.max(this.lower, 1e-20)) - this.carrierDb, 1));
      rFloor.set(this.floor === null ? '—' : this.floor.toExponential(2),
        this.floor === null ? 'measuring' : `alert at ${ALERT_SIGMA}×`);

      specCap.textContent = `±${BAND_HZ} HZ AROUND ${fmt(this.carrierHz / 1000, 1)} KHZ · GUARD ±${GUARD_HZ} HZ`;
      this.drawSpectrum(spec);
      this.drawTrace(traceC);
    });
  }

  private startEmit(ctx: AudioContext): void {
    if (this.emitting) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = this.carrierHz;
    gain.gain.value = this.level;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    this.osc = osc;
    this.emitGain = gain;
    this.emitting = true;
    this.resetFloor();
    if (this.btnEmit) this.btnEmit.textContent = 'Stop emitting';
  }

  private stopEmit(): void {
    if (!this.emitting) return;
    try { this.osc?.stop(); } catch { /* already stopped */ }
    for (const n of [this.osc, this.emitGain]) { try { n?.disconnect(); } catch { /* gone */ } }
    this.osc = null;
    this.emitGain = null;
    this.emitting = false;
    if (this.btnEmit) this.btnEmit.textContent = 'Start emitting';
  }

  private resetFloor(): void {
    this.floor = null;
    this.learnStart = 0;
    this.learnSum = 0;
    this.learnCount = 0;
    this.index = 0;
    this.peakIndex = 0;
    this.trace = [];
  }

  /** Sideband energy either side of the carrier, as a ratio to the carrier. */
  private measure(dt: number): void {
    if (!this.binHz) return;
    const guard = Math.max(2, Math.ceil(GUARD_HZ / this.binHz));
    const band = Math.ceil(BAND_HZ / this.binHz);
    const n = this.bins.length;

    // Carrier level: peak within a couple of bins, since the oscillator will
    // not land exactly on a bin centre.
    let cDb = FLOOR_DB;
    for (let i = Math.max(0, this.carrierBin - 2); i <= Math.min(n - 1, this.carrierBin + 2); i++) {
      if (this.bins[i] > cDb) cDb = this.bins[i];
    }
    this.carrierDb = cDb;

    // Out-of-band reference: just beyond the analysis band on both sides, so
    // it sees the same noise the sidebands sit in but none of the signal.
    const refInner = band + Math.ceil(100 / this.binHz);
    const refOuter = refInner + Math.ceil(400 / this.binHz);
    let refSum = 0, refCount = 0;
    for (let k = refInner; k <= refOuter; k++) {
      for (const i of [this.carrierBin + k, this.carrierBin - k]) {
        if (i >= 0 && i < n && Number.isFinite(this.bins[i])) { refSum += Math.pow(10, this.bins[i] / 10); refCount++; }
      }
    }
    this.noiseDb = refCount ? 10 * Math.log10(refSum / refCount) : FLOOR_DB;
    this.carrierSnr = cDb - this.noiseDb;

    let up = 0, lo = 0;
    for (let k = guard; k <= band; k++) {
      const hi = this.carrierBin + k;
      const li = this.carrierBin - k;
      if (hi < n) up += Math.pow(10, this.bins[hi] / 10);
      if (li >= 0) lo += Math.pow(10, this.bins[li] / 10);
    }
    this.upper = up;
    this.lower = lo;

    const total = up + lo;
    this.asymmetry = total > 0 ? (up - lo) / total : 0;

    // Ratio to carrier power, not absolute energy: that makes the index
    // invariant to emitter level and to how reflective the room happens to be,
    // so the same threshold means the same thing everywhere.
    const carrierP = Math.pow(10, cDb / 10);
    this.ratio = carrierP > 0 ? total / carrierP : 0;

    if (!this.emitting || this.carrierSnr < CARRIER_SNR_DB) return;

    if (this.floor === null) {
      if (this.learnStart === 0) this.learnStart = performance.now();
      this.learnSum += this.ratio;
      this.learnCount++;
      if (performance.now() - this.learnStart >= LEARN_S * 1000 && this.learnCount > 20) {
        this.floor = Math.max(this.learnSum / this.learnCount, 1e-12);
      }
      return;
    }

    this.index = this.ratio / this.floor;
    if (this.index > this.peakIndex) this.peakIndex = this.index;

    // Freeze while triggered, so motion cannot raise the floor it is measured
    // against — the same trap Instrument 7 hit.
    if (this.index < FLOOR_FREEZE_SIGMA) {
      const alpha = 1 - Math.exp(-dt / FLOOR_TAU);
      this.floor = Math.max(1e-12, this.floor + (this.ratio - this.floor) * alpha);
    }

    this.trace.push(this.index);
    if (this.trace.length > TRACE_N) this.trace.shift();
  }

  /** Offset of the strongest sideband bin, in Hz. Signed: + is approaching. */
  private dominantShift(): number | null {
    if (!this.binHz) return null;
    const guard = Math.max(2, Math.ceil(GUARD_HZ / this.binHz));
    const band = Math.ceil(BAND_HZ / this.binHz);
    let best = 0, bestDb = -Infinity;
    for (let k = guard; k <= band; k++) {
      for (const sgn of [1, -1]) {
        const i = this.carrierBin + sgn * k;
        if (i < 0 || i >= this.bins.length) continue;
        if (this.bins[i] > bestDb) { bestDb = this.bins[i]; best = sgn * k; }
      }
    }
    return best === 0 ? null : best * this.binHz;
  }

  /** Spectrum around the carrier, with the guard band shaded out. */
  private drawSpectrum(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h || !this.binHz) return;
    ctx.clearRect(0, 0, w, h);

    const band = Math.ceil(BAND_HZ / this.binHz);
    const guard = Math.max(2, Math.ceil(GUARD_HZ / this.binHz));
    const xOf = (k: number) => ((k + band) / (2 * band)) * w;
    const top = this.carrierDb;
    const range = 60;
    const yOf = (db: number) => h - 12 - ((Math.max(db, top - range) - (top - range)) / range) * (h - 20);

    // Guard band — shaded, because nothing in it is usable.
    ctx.fillStyle = alpha(col.text, 0.03);
    ctx.fillRect(xOf(-guard), 0, xOf(guard) - xOf(-guard), h - 12);

    ctx.beginPath();
    for (let k = -band; k <= band; k++) {
      const i = this.carrierBin + k;
      const db = i >= 0 && i < this.bins.length ? this.bins[i] : FLOOR_DB;
      const x = xOf(k), y = yOf(db);
      if (k === -band) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = col.trace[0];
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Carrier marker and velocity ticks.
    ctx.strokeStyle = alpha(col.dark2, 0.53);
    ctx.beginPath(); ctx.moveTo(xOf(0), 0); ctx.lineTo(xOf(0), h - 12); ctx.stroke();

    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = col.dimmer;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of [-4, -2, -1, 1, 2, 4]) {
      const k = shiftFor(v, this.carrierHz) / this.binHz;
      if (Math.abs(k) > band) continue;
      ctx.fillText(`${v > 0 ? '+' : ''}${v}`, xOf(k), h - 10);
    }
    ctx.textAlign = 'left';
    ctx.fillText('m/s · ← receding', 4, 4);
    ctx.textAlign = 'right';
    ctx.fillText('approaching →', w - 4, 4);
  }

  private drawTrace(c: ReturnType<typeof autoCanvas>): void {
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
      ctx.fillText(this.emitting ? 'LEARNING QUIET FLOOR' : 'EMITTER OFF', w / 2, h / 2);
      return;
    }
    const MAX = 100;
    const yOf = (v: number) => {
      const t = Math.log10(Math.max(v, 0.5) / 0.5) / Math.log10(MAX / 0.5);
      return h - 12 - t * (h - 20);
    };
    ctx.strokeStyle = alpha(col.bad, 0.6);
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(0, yOf(ALERT_SIGMA)); ctx.lineTo(w, yOf(ALERT_SIGMA)); ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    for (let i = 0; i < this.trace.length; i++) {
      const x = (i / (TRACE_N - 1)) * w;
      const y = yOf(this.trace[i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = col.ok;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function micErrorHtml(err: AudioUnavailableError): string {
  const base = `<strong>Microphone unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base +
      '<ul>' +
      '<li><strong>Safari</strong> — Settings → Safari → Microphone, or clear this site\'s website data and reload.</li>' +
      '<li><strong>Chrome / Edge</strong> — in-app Settings → Site Settings → Microphone, and check Settings → Privacy &amp; Security → Microphone allows the browser itself.</li>' +
      '</ul>';
  }
  return base;
}
