/**
 * Instrument 10 — Acoustic sonar rangefinder (§8.10).
 *
 * Matched-filter time-of-flight. Emit a Hann-windowed 15→22 kHz chirp, capture
 * through an AudioWorklet stamped with absolute frame indices, cross-correlate
 * against the reference, and read the delay. At 48 kHz one sample is 7.15 mm
 * of path, so 3.6 mm of range resolution.
 *
 * Presented as an A-scope — correlation amplitude against range — rather than
 * a single number. §8.10 asks for that and it is right twice over: the trace
 * is more honest, because you can see whether there is one clean return or a
 * confusion of them, and it is more tricorder-like.
 *
 * Everything the earlier audio instruments paid for is inherited here:
 *   - The `raw` mic profile is MANDATORY. Echo cancellation exists precisely
 *     to remove sound the device just emitted; it would cancel our chirp.
 *   - The graph must terminate at the destination or WebKit never runs it
 *     (§0.7) — which for a worklet means no samples at all, silently.
 *   - Carrier presence is judged against out-of-band noise, never an absolute
 *     dBFS threshold (learned on Instrument 8).
 *
 * Honest expectations: 0.2–3 m against a large flat surface in a quiet room,
 * and pointing-sensitive. This is the finickiest instrument in the set.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireMic, profileApplied, AudioUnavailableError, type MicHandle } from '../sensors/audio';
import { SonarCapture } from '../sensors/sonar-capture';
import { makeChirp, matchedFilter, lagToRange, rangeToLag, SPEED_OF_SOUND } from '../lib/dsp';

const CHIRP_MS = 10;
const F_LOW = 15000;
const F_HIGH = 22000;
/** Capture window per ping. 4096 at 48 kHz is ~85 ms, about 14 m of round trip. */
const CAPTURE_N = 4096;
/**
 * FFT size for the matched filter. MUST exceed capture + reference, or the
 * correlation is circular and the direct-path leak's peak wraps into the far
 * end of the trace — where it outweighs any real echo and pins every reading
 * to maximum range. See the note on matchedFilter().
 */
const FFT_N = 8192;
/**
 * Blanking, ms. The speaker and microphone are centimetres apart, so the
 * direct path is the largest thing in every correlation by a wide margin.
 * 1.5 ms of blanking costs us everything closer than about 26 cm.
 */
const BLANK_MS = 1.5;
/** Refuse to report beyond this; §8.10 puts the realistic ceiling near 3 m. */
const MAX_RANGE_M = 6;
/** Pings per measurement. §8.10 suggests 4–8 and a median. */
const PINGS = 6;
/** Gap between pings, ms — long enough for the room to go quiet again. */
const PING_GAP_MS = 140;
/**
 * Agreement required between individual pings, mm.
 *
 * This is the strongest validity test available and it costs nothing.
 * Independent pings off a real wall agree to within a couple of centimetres;
 * noise does not agree with itself at all. In testing with no acoustic path,
 * six pings landed 5.6 m apart and the instrument still reported a confident
 * "clear return" — a median of six disagreeing numbers is not a measurement.
 */
const AGREE_MM = 60;
/** Of PINGS pings, at least this many must agree before anything is reported. */
const MIN_AGREE = 3;
/**
 * Peaks this close to the blanking edge are rejected.
 *
 * A peak sitting on the first unblanked sample is almost always the shoulder
 * of the direct-path correlation rather than a target — blanking removes the
 * body of that peak, not its skirt.
 */
const EDGE_GUARD_SAMPLES = 24;
/**
 * How far a peak must stand above its own neighbourhood to count as a target.
 *
 * Comparing the peak against the GLOBAL median is not enough, and the failure
 * is instructive: the direct-path correlation decays smoothly outward from lag
 * zero, so the first sample of any search window is a local maximum sitting
 * well above the median of the whole trace. Every ping then finds the same
 * point, they agree with each other perfectly, and the consistency test — the
 * strongest check here — waves it through. A real reflection is a lobe that
 * rises out of its surroundings; a skirt is not.
 */
const MIN_PROMINENCE = 4;
/** Half-width of the neighbourhood prominence is measured against, samples. */
const PROMINENCE_WINDOW = 220;

export class SonarInstrument extends Instrument {
  readonly id = 'sonar';
  readonly title = 'Acoustic Sonar';
  override readonly subtitle = 'Matched-filter time of flight';
  override readonly resources = 'microphone (raw) + speaker';

  private mic: MicHandle | null = null;
  private capture: SonarCapture | null = null;
  private chirp: Float32Array | null = null;
  private chirpBuf: AudioBuffer | null = null;
  private sampleRate = 48000;
  private level = 0.25;
  private busy = false;

  private envelope: Float32Array | null = null;
  private noiseLevel = 0;
  private rangeM: number | null = null;
  private spreadMm = 0;
  /** Peak prominence above its local neighbourhood, not a global ratio. */
  private snr = 0;
  private agreeing = 0;
  private lastRanges: number[] = [];
  /**
   * The direct speaker-to-microphone leak.
   *
   * It is the one return guaranteed to exist — the two are centimetres apart —
   * which makes it the reference that says whether the audio chain works at
   * all. Without it, "no consistent return" is ambiguous between a difficult
   * room and no sound leaving the phone, and those need completely different
   * responses.
   */
  private directLag = 0;
  private directVal = 0;
  private status = '';

  protected async build(root: HTMLElement): Promise<void> {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);
    const statusBox = el('div');

    append(scroll,
      notice('warn',
        `<strong>This emits a brief ${F_LOW / 1000}–${F_HIGH / 1000} kHz chirp for each ping.</strong> Most adults cannot hear it; children and animals generally can. ` +
        'It only sounds while a measurement is running, and stops when you leave this screen.'),
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
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* reported below */ } }

    if (!profileApplied(this.mic.settings, 'raw')) {
      append(statusBox, notice('bad',
        '<strong>Raw mic profile not fully applied — this instrument cannot work.</strong> Echo cancellation exists specifically to remove sound the device just emitted. It will cancel the chirp, and there will be nothing to correlate against.'));
    }

    // Chirp, clamped so the sweep stays clear of Nyquist on a 44.1 kHz device.
    const fHigh = Math.min(F_HIGH, this.sampleRate / 2 - 1500);
    this.chirp = makeChirp(this.sampleRate, CHIRP_MS / 1000, F_LOW, fHigh);
    const buf = ctx.createBuffer(1, this.chirp.length, this.sampleRate);
    buf.getChannelData(0).set(this.chirp);
    this.chirpBuf = buf;

    this.capture = new SonarCapture(ctx, 2);
    try {
      await this.capture.start(this.mic.source);
    } catch (e) {
      append(statusBox, notice('bad',
        `<strong>Could not start the capture worklet.</strong> ${escapeHtml(e instanceof Error ? e.message : String(e))}`));
      return;
    }
    if (!this.isMounted) { this.capture.stop(); return; }
    this.onCleanup(() => this.capture?.stop());

    // --- controls ---------------------------------------------------------
    const btnPing = el('button', { class: 'btn', type: 'button' }, `Ping ×${PINGS}`);
    btnPing.addEventListener('click', () => void this.measure(btnPing));
    const levelInput = el('input', {
      type: 'range', min: '0.05', max: '1', step: '0.05',
      value: String(this.level), class: 'rf__input', style: 'width:140px;padding:0',
    }) as HTMLInputElement;
    levelInput.addEventListener('input', () => { this.level = parseFloat(levelInput.value); });

    append(scroll, section('Ranging'),
      el('div', { class: 'rf__row' }, btnPing, el('label', { class: 'rf__label', text: 'Level' }), levelInput));

    // --- readouts ---------------------------------------------------------
    const rRange = readout('Range', { unit: 'm', note: '', wide: true });
    const rSnr = readout('Peak prominence', { unit: '×', note: 'above its surroundings' });
    const rSpread = readout('Ping spread', { unit: 'mm', note: `across ${PINGS} pings` });
    const rRes = readout('Resolution', { unit: 'mm', note: '' });
    const rDirect = readout('Direct path', { note: 'speaker → mic — proves audio works' });
    const rPings = readout('Ping results', { note: '', wide: true });

    append(scroll, rRange.node,
      el('div', { class: 'grid' }, rSnr.node, rSpread.node, rRes.node),
      el('div', { class: 'grid' }, rDirect.node),
      rPings.node);

    // --- A-scope ----------------------------------------------------------
    const scope = autoCanvas();
    const scopeBox = el('div', { class: 'scope', style: 'height:min(32dvh,260px)' }, scope.node);
    const scopeCap = el('div', { class: 'scope__cap', text: 'A-SCOPE' });
    append(scopeBox, scopeCap);
    append(scroll, section('A-scope — correlation against range'), scopeBox);

    append(scroll, notice('warn',
      `<strong>What to expect, honestly.</strong> 0.2–3 m against a large flat surface in a quiet room, and it is pointing-sensitive — this is the finickiest instrument here. ` +
      `Everything closer than ${fmt(lagToRange(BLANK_MS / 1000 * this.sampleRate, this.sampleRate), 2)} m is blanked, because the speaker sits centimetres from the microphone and the direct path dominates every correlation. ` +
      'Read the trace, not just the number: one clean lobe is a real surface, and a forest of similar peaks means the return is ambiguous and the number on top is arbitrary.'));

    // --- render -----------------------------------------------------------
    let lastStatus = '';
    this.loop(() => {
      scope.resize();
      if (this.status !== lastStatus) {
        lastStatus = this.status;
        clear(statusBox);
        if (this.status) {
          append(statusBox, notice(this.status.startsWith('!') ? 'bad' : 'warn',
            this.status.replace(/^!/, '')));
        }
      }

      const r = this.rangeM;
      const tooFar = r !== null && r > MAX_RANGE_M;
      rRange.set(r === null ? '—' : tooFar ? 'OUT OF RANGE' : fmt(r, 3),
        r === null ? 'press Ping' : tooFar ? `beyond ${MAX_RANGE_M} m` : `${fmt(r * 100, 1)} cm`);
      rRange.setState(r === null ? 'idle' : tooFar ? 'bad' : this.snr > 6 ? 'ok' : 'warn');

      // Cap the displayed ratio. With no acoustic path the noise median can
      // approach zero and produce six-figure "confidence" for pure garbage,
      // which is worse than saying nothing.
      const shownSnr = Math.min(this.snr, 9999);
      rSnr.set(this.snr ? fmt(shownSnr, 1) : '—',
        r === null ? `below the ${MIN_PROMINENCE}× a real reflection needs`
          : this.snr > 8 ? 'clear return' : 'weak — treat with suspicion');
      rSnr.setState(r === null ? 'bad' : this.snr > 8 ? 'ok' : 'warn');
      rSpread.set(this.lastRanges.length ? fmt(this.spreadMm, 0) : '—',
        this.lastRanges.length
          ? `${this.agreeing} of ${this.lastRanges.length} pings agree · need ${MIN_AGREE}`
          : `across ${PINGS} pings`);
      rSpread.setState(!this.lastRanges.length ? 'idle'
        : this.agreeing >= MIN_AGREE ? 'ok' : 'bad');
      rRes.set(fmt(SPEED_OF_SOUND / (2 * this.sampleRate) * 1000, 2),
        `1 sample @ ${fmt(this.sampleRate / 1000, 1)} kHz`);

      rDirect.set(this.directVal > 0 ? 'HEARD' : this.lastRanges.length ? 'ABSENT' : '—',
        this.directVal > 0
          ? `lag ${fmt(this.directLag, 1)} samples · ${fmt(lagToRange(this.directLag, this.sampleRate) * 100, 1)} cm`
          : this.lastRanges.length ? 'no sound reaching the mic — check the mute switch' : '');
      rDirect.setState(this.directVal > 0 ? 'ok' : this.lastRanges.length ? 'bad' : 'idle');

      rPings.set(this.lastRanges.length ? `${this.agreeing}/${this.lastRanges.length}` : '—',
        this.lastRanges.length
          ? this.lastRanges.map((v) => `${v.toFixed(2)}`).join('  ') + ' m'
          : 'individual ping ranges appear here');
      rPings.setState(!this.lastRanges.length ? 'idle' : this.agreeing >= MIN_AGREE ? 'ok' : 'warn');

      this.drawScope(scope);
    });
  }

  /** Fire the ping train, correlate each return, report the median. */
  private async measure(btn: HTMLButtonElement): Promise<void> {
    const ctx = this.mic?.ctx;
    const cap = this.capture;
    const chirp = this.chirp;
    if (!ctx || !cap || !chirp || !this.chirpBuf || this.busy) return;

    this.busy = true;
    btn.disabled = true;
    btn.textContent = 'Pinging…';
    this.status = '';
    const ranges: number[] = [];
    // Holds the coherently averaged raw capture, so it is capture-length.
    const stack = new Float32Array(CAPTURE_N);
    let stacked = 0;

    // One search window, used for BOTH the per-ping peaks and the stacked
    // envelope. Applying the edge guard to only one of them let every
    // individual ping lock onto the direct-path shoulder at the blanking edge
    // — and then agree with each other perfectly, which the consistency test
    // read as a confident measurement of 0.257 m. Consistent nonsense is
    // harder to catch than inconsistent nonsense.
    const blankLag = Math.round((BLANK_MS / 1000) * this.sampleRate);
    const searchLo = blankLag + EDGE_GUARD_SAMPLES;
    const maxLag = Math.min(CAPTURE_N - chirp.length, Math.round(rangeToLag(MAX_RANGE_M, this.sampleRate)));

    try {
      for (let p = 0; p < PINGS && this.isMounted; p++) {
        // Schedule with a lead so the emission time is known exactly rather
        // than being whenever the thread got round to it.
        const at = ctx.currentTime + 0.06;
        const src = ctx.createBufferSource();
        src.buffer = this.chirpBuf;
        const g = ctx.createGain();
        g.gain.value = this.level;
        src.connect(g);
        g.connect(ctx.destination);
        src.start(at);
        const emitFrame = Math.round(at * this.sampleRate);

        // Wait for the capture window to fill.
        const deadline = performance.now() + 1500;
        let win: Float32Array | null = null;
        while (performance.now() < deadline) {
          win = cap.read(emitFrame, CAPTURE_N);
          if (win) break;
          await sleep(10);
        }
        try { src.disconnect(); g.disconnect(); } catch { /* done */ }
        if (!win) { this.status = '!<strong>No samples captured.</strong> The microphone worklet is not delivering audio. Leave and re-enter the screen to re-acquire it.'; break; }

        const env = matchedFilter(win, chirp, FFT_N);
        stacked++;

        const peak = pickPeak(env, searchLo, maxLag);
        if (peak) ranges.push(lagToRange(peak.lag, this.sampleRate));

        await sleep(PING_GAP_MS);
      }

      if (stacked) {
        for (let i = 0; i < CAPTURE_N; i++) stack[i] /= stacked;
        const stackEnv = matchedFilter(stack.subarray(0, CAPTURE_N), chirp, FFT_N);
        this.envelope = stackEnv;

        // The direct path: the leak lives inside the blanked region, and it is
        // the proof that sound is making the trip at all.
        const direct = pickPeak(stackEnv, 1, blankLag + EDGE_GUARD_SAMPLES);
        this.directLag = direct ? direct.lag : 0;
        this.directVal = direct ? direct.value : 0;

        const peak = pickPeak(stackEnv, searchLo, maxLag);
        // Prominence, not global SNR. See MIN_PROMINENCE.
        this.noiseLevel = peak ? localBaseline(stackEnv, Math.round(peak.lag), searchLo, maxLag) : 0;
        this.snr = peak && this.noiseLevel > 1e-12 ? peak.value / this.noiseLevel : 0;

        // Consistency is the real test. Find the largest cluster of pings that
        // agree with each other, and report only if enough of them do.
        ranges.sort((a, b) => a - b);
        this.lastRanges = ranges;
        const cluster = largestCluster(ranges, AGREE_MM / 1000);
        this.agreeing = cluster.length;
        this.spreadMm = cluster.length > 1
          ? (cluster[cluster.length - 1] - cluster[0]) * 1000
          : 0;

        if (cluster.length >= MIN_AGREE && this.snr >= MIN_PROMINENCE) {
          this.rangeM = cluster[cluster.length >> 1];
        } else if (this.directVal <= 0 || this.snr === 0) {
          this.rangeM = null;
          this.status = '!<strong>The microphone never heard the chirp.</strong> Not even the direct path from the speaker, which is only centimetres away and should be the loudest thing in every ping. That is not a difficult room — no sound is leaving the phone.' +
            '<ul>' +
            '<li><strong>Check the hardware mute switch.</strong> On iOS it silences Web Audio output completely. This is the usual cause.</li>' +
            '<li>Turn the media volume up, and raise the Level slider.</li>' +
            '<li>If headphones or a Bluetooth speaker are connected, the chirp is going there.</li>' +
            '</ul>';
        } else {
          this.rangeM = null;
          this.status = cluster.length < MIN_AGREE && ranges.length
            ? `<strong>No consistent return.</strong> The ${ranges.length} pings disagreed — only ${cluster.length} of them landed within ${AGREE_MM} mm of each other, and independent pings off a real surface agree far more closely than that. ` +
              'Point squarely at something large and flat — a wall or a door — from under three metres, hold still, and raise the level. Soft, angled or cluttered surfaces scatter the chirp and return nothing coherent.'
            : `<strong>No usable return.</strong> The strongest peak stands only ${fmt(this.snr, 1)}× above its surroundings, and a real reflection needs ${MIN_PROMINENCE}×. ` +
              'Point squarely at a large flat surface from under three metres, hold still, and raise the level.';
        }
      }
    } finally {
      this.busy = false;
      btn.disabled = false;
      btn.textContent = `Ping ×${PINGS}`;
    }
  }

  /** Correlation amplitude against range, with the blanked zone shaded. */
  private drawScope(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    const env = this.envelope;
    const maxLag = Math.round(rangeToLag(MAX_RANGE_M, this.sampleRate));
    // Shade what is actually excluded, which is the blanking plus the edge
    // guard — not just the blanking. Showing a narrower exclusion than the
    // one the peak search uses would misrepresent where a reading can come
    // from.
    const searchLo = Math.round((BLANK_MS / 1000) * this.sampleRate) + EDGE_GUARD_SAMPLES;
    const xOf = (lag: number) => (lag / maxLag) * w;

    // Range grid, in metres.
    ctx.font = "9px ui-monospace, monospace";
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (let m = 1; m <= MAX_RANGE_M; m++) {
      const x = xOf(rangeToLag(m, this.sampleRate));
      ctx.strokeStyle = '#1a1a24';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke();
      ctx.fillStyle = '#4a4454';
      ctx.fillText(`${m}m`, x, h - 12);
    }

    // Blanked region — shaded, because nothing in it is a measurement.
    ctx.fillStyle = '#ffffff0a';
    ctx.fillRect(0, 0, xOf(searchLo), h - 14);
    ctx.fillStyle = '#6a6274';
    ctx.textAlign = 'left';
    ctx.fillText('blanked', 3, 4);

    if (!env) {
      ctx.fillStyle = '#3a3a48';
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('NO DATA — PRESS PING', w / 2, h / 2);
      return;
    }

    let max = 1e-9;
    for (let i = searchLo; i < maxLag; i++) if (env[i] > max) max = env[i];

    ctx.beginPath();
    for (let lag = 0; lag < maxLag; lag++) {
      const x = xOf(lag);
      const y = (h - 16) - (env[lag] / max) * (h - 26);
      if (lag === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffcc66';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    if (this.rangeM !== null && this.snr >= 3) {
      const x = xOf(rangeToLag(this.rangeM, this.sampleRate));
      ctx.strokeStyle = '#66cc88';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 14); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#66cc88';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`${this.rangeM.toFixed(3)} m`, Math.min(x + 4, w - 46), 4);
    }
  }
}

/** Strongest local maximum in [lo, hi), with sub-sample interpolation. */
function pickPeak(env: Float32Array, lo: number, hi: number): { lag: number; value: number } | null {
  let best = -1, bestV = -Infinity;
  for (let i = Math.max(lo, 1); i < Math.min(hi, env.length - 1); i++) {
    if (env[i] > bestV && env[i] >= env[i - 1] && env[i] >= env[i + 1]) { bestV = env[i]; best = i; }
  }
  if (best < 0) return null;
  // Parabolic interpolation: the resolution is 3.6 mm per sample, so landing
  // on the nearest whole sample throws away real precision.
  const a = env[best - 1], b = env[best], c = env[best + 1];
  const denom = a - 2 * b + c;
  const d = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0;
  return { lag: best + (Math.abs(d) <= 1 ? d : 0), value: bestV };
}

/**
 * Largest set of values that all lie within `tol` of one another.
 *
 * A plain median is not good enough: the median of six numbers spread over
 * five metres is still a number, and it looks exactly like a measurement.
 * Clustering asks the right question — did several independent pings actually
 * find the same surface?
 */
function largestCluster(sorted: number[], tol: number): number[] {
  let best: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[i] <= tol) j++;
    if (j - i + 1 > best.length) best = sorted.slice(i, j + 1);
  }
  return best;
}

/**
 * Median of the envelope around `at`, excluding the peak itself — the level
 * the peak has to stand out from.
 */
function localBaseline(env: Float32Array, at: number, lo: number, hi: number): number {
  const vals: number[] = [];
  const from = Math.max(lo, at - PROMINENCE_WINDOW);
  const to = Math.min(hi, at + PROMINENCE_WINDOW);
  for (let i = from; i < to; i++) {
    if (Math.abs(i - at) < 12) continue;   // skip the lobe itself
    vals.push(env[i]);
  }
  return medianOf(vals);
}

function medianOf(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function micErrorHtml(err: AudioUnavailableError): string {
  const base = `<strong>Microphone unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base + ' Check the site\'s microphone permission, and that Settings → Privacy &amp; Security → Microphone allows the browser itself.';
  }
  return base;
}
