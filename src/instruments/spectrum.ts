/**
 * Instrument 5 — Audio spectrum analyzer (§8.5).
 *
 * Acquires the mic with the `raw` profile: AGC would rescale amplitude between
 * frames and noise suppression would carve holes in the noise floor, and both
 * make the display lie. Log-frequency X, dBFS Y, peak hold, and a
 * parabolically-interpolated dominant-frequency readout good enough to tune to.
 *
 * dBFS, never SPL — a phone mic cannot be calibrated against a reference (§2).
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, escapeHtml } from '../ui/dom';
import { acquireMic, profileApplied, AudioUnavailableError, type MicHandle } from '../sensors/audio';
import { parabolicPeak } from '../lib/dsp';
import { theme, alpha } from '../ui/theme';

const FFT_SIZE = 16384;
const MIN_HZ = 20;
/**
 * Dominant-frequency search floor. Below this the spectrum is dominated by the
 * monotonic rumble skirt — handling noise, HVAC, the mic's own DC blob — which
 * is genuinely the tallest thing on screen but is never the note you are
 * looking for. 40 Hz sits just under E1 (41.2 Hz), the lowest note a bass
 * guitar produces, so nothing musical is excluded.
 */
const SEARCH_MIN_HZ = 40;
const FLOOR_DB = -110;
const CEIL_DB = -10;

export class SpectrumInstrument extends Instrument {
  readonly id = 'spectrum';
  readonly title = 'Spectrum Analyzer';
  override readonly subtitle = 'Audio FFT · dBFS';
  override readonly resources = 'microphone (raw profile)';

  private mic: MicHandle | null = null;
  private analyser: AnalyserNode | null = null;
  private bins: Float32Array = new Float32Array(0);
  private timeDomain: Float32Array = new Float32Array(0);
  private inputRms = 0;
  private silentFrames = 0;
  private peaks: Float32Array = new Float32Array(0);
  private peakHold = true;
  private sampleRate = 0;
  private binHz = 0;
  private dominantHz = 0;
  private dominantDb = FLOOR_DB;
  private broadbandDb = FLOOR_DB;

  protected async build(root: HTMLElement): Promise<void> {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    const statusBox = el('div');
    append(scroll, statusBox);

    // Acquire on activate, release on exit — never a global stream (§5).
    try {
      this.mic = await acquireMic('raw');
    } catch (e) {
      const err = e as AudioUnavailableError;
      append(statusBox, notice('bad', micErrorHtml(err)));
      return;
    }
    // The screen may have been left while getUserMedia was still pending.
    if (!this.isMounted) { this.mic.release(); return; }
    this.onCleanup(() => this.mic?.release());

    const ctx = this.mic.ctx;
    this.sampleRate = ctx.sampleRate;
    const analyser = ctx.createAnalyser();
    // fftSize is clamped to 32768; 16384 gives ~2.9 Hz bins at 48 kHz.
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.55;
    analyser.minDecibels = FLOOR_DB;
    analyser.maxDecibels = CEIL_DB;
    this.mic.source.connect(analyser);

    // WebKit only pulls an audio graph that terminates at the destination. An
    // AnalyserNode left dangling is never fed, and getFloatFrequencyData
    // returns a flat -Infinity forever — silently, with no error. (Chromium
    // processes it regardless, so this reproduces ONLY on the target platform.)
    // Terminating through a zero-gain node keeps the graph live while emitting
    // nothing, so there is no feedback path from speaker to mic.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    analyser.connect(mute);
    mute.connect(ctx.destination);

    this.analyser = analyser;
    this.onCleanup(() => {
      for (const n of [analyser, mute]) { try { n.disconnect(); } catch { /* gone */ } }
    });

    // iOS can re-negotiate the audio session when a mic track goes live and
    // leave the context suspended behind our back.
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* surfaced below */ } }

    this.binHz = this.sampleRate / analyser.fftSize;
    this.bins = new Float32Array(analyser.frequencyBinCount);
    this.timeDomain = new Float32Array(analyser.fftSize);
    this.peaks = new Float32Array(analyser.frequencyBinCount).fill(FLOOR_DB);

    if (!profileApplied(this.mic.settings, 'raw')) {
      append(statusBox, notice('warn',
        '<strong>Raw mic profile not fully applied.</strong> The browser kept part of its voice DSP chain (AGC / noise suppression / echo cancellation). Levels and the noise floor will not be trustworthy.'));
    }

    // --- Spectrum ---------------------------------------------------------
    const spec = autoCanvas();
    const specBox = el('div', { class: 'scope', style: 'height:min(42dvh,340px)' }, spec.node);
    const specCap = el('div', { class: 'scope__cap', text: '' });
    append(specBox, specCap);
    append(scroll, section('Spectrum'), specBox);

    const rDom = readout('Dominant', { unit: 'Hz', note: '' });
    const rNote = readout('Nearest note', { note: '' });
    const rLevel = readout('Peak level', { unit: 'dBFS', note: '' });
    const rBroad = readout('Broadband', { unit: 'dBFS', note: 'RMS across all bins' });
    const rBin = readout('Bin width', { unit: 'Hz', note: '' });
    const rRate = readout('Sample rate', { unit: 'Hz', note: '' });
    const rInput = readout('Input RMS', { note: 'time domain — proves samples are arriving' });

    append(
      scroll,
      el('div', { class: 'grid' }, rDom.node, rNote.node),
      el('div', { class: 'grid' }, rLevel.node, rBroad.node, rInput.node),
      el('div', { class: 'grid' }, rBin.node, rRate.node),
    );

    const btnPeak = el('button', { class: 'btn', type: 'button' }, 'Peak hold: on');
    btnPeak.addEventListener('click', () => {
      this.peakHold = !this.peakHold;
      btnPeak.textContent = `Peak hold: ${this.peakHold ? 'on' : 'off'}`;
      if (!this.peakHold) this.peaks.fill(FLOOR_DB);
    });
    const btnClear = el('button', { class: 'btn btn--alt', type: 'button' }, 'Clear peaks');
    btnClear.addEventListener('click', () => this.peaks.fill(FLOOR_DB));

    append(
      scroll,
      el('div', { class: 'btn-row' }, btnPeak, btnClear),
      notice('warn',
        '<strong>dBFS, not dB SPL.</strong> Absolute sound pressure needs a calibrated reference the phone does not have, so 0 dBFS is simply digital full scale on this microphone. Compare readings to each other, not to a sound-level meter.'),
    );

    // Sits directly under the status box at the top, where an error belongs —
    // not below the fold with the buttons.
    const silenceBox = el('div');
    scroll.insertBefore(silenceBox, statusBox.nextSibling);
    let silenceShown = false;
    const renderSilence = () => {
      // ~2 s of exact zeros is not a quiet room, it is a broken pipeline.
      const dead = this.silentFrames > 120;
      if (dead === silenceShown) return;
      silenceShown = dead;
      silenceBox.replaceChildren();
      if (dead) {
        silenceBox.appendChild(notice('bad',
          '<strong>No audio samples are arriving.</strong> Time-domain input is exactly zero <em>and</em> every frequency bin is -Infinity, which is a dead graph rather than a quiet room.' +
          '<ul>' +
          '<li>Check the microphone permission was actually granted for this site.</li>' +
          '<li>Another app or tab may hold the microphone — iOS gives it to one client at a time.</li>' +
          '<li>Leave this screen and come back; that re-acquires the track from scratch.</li>' +
          '</ul>'));
      }
    };

    // --- Render -----------------------------------------------------------
    this.loop(() => {
      spec.resize();
      const a = this.analyser;
      if (!a) return;

      a.getFloatFrequencyData(this.bins as Float32Array<ArrayBuffer>);
      a.getFloatTimeDomainData(this.timeDomain as Float32Array<ArrayBuffer>);
      const minBin = Math.max(1, Math.floor(MIN_HZ / this.binHz));

      // Distinguishing "the room is silent" from "the audio pipeline is
      // broken" needs two different pieces of evidence, because either one
      // alone gives false positives:
      //   - time-domain RMS of exactly zero. A real microphone always has a
      //     noise floor, so exact zero means no samples. But a synthetic or
      //     muted source can also emit true digital silence.
      //   - every frequency bin at -Infinity. An analyser that is never fed
      //     has an internal magnitude of zero, and 20·log10(0) is -Infinity.
      //     A merely quiet room still produces finite, very negative bins.
      // Requiring both is what separates a dead graph from a quiet one.
      let sq = 0;
      for (let i = 0; i < this.timeDomain.length; i++) sq += this.timeDomain[i] * this.timeDomain[i];
      this.inputRms = Math.sqrt(sq / this.timeDomain.length);

      let anyFinite = false;
      for (let i = minBin; i < this.bins.length; i += 16) {
        if (Number.isFinite(this.bins[i])) { anyFinite = true; break; }
      }
      if (this.inputRms === 0 && !anyFinite) this.silentFrames++; else this.silentFrames = 0;
      renderSilence();

      const searchMin = Math.max(minBin + 1, Math.floor(SEARCH_MIN_HZ / this.binHz));
      let best = -1;
      let sumPow = 0;
      let counted = 0;
      for (let i = minBin; i < this.bins.length; i++) {
        const v = this.bins[i];
        if (Number.isFinite(v)) { sumPow += Math.pow(10, v / 10); counted++; }
        if (this.peakHold && v > this.peaks[i]) this.peaks[i] = v;
        // Only true local maxima are candidates. Taking the global max instead
        // just returns the top of the low-frequency skirt every time.
        if (i >= searchMin && i < this.bins.length - 1 &&
            v > this.bins[i - 1] && v >= this.bins[i + 1] &&
            (best < 0 || v > this.bins[best])) {
          best = i;
        }
      }
      if (best < 0) best = searchMin;

      this.dominantDb = this.bins[best];
      // Interpolate in the dB domain — near a peak it is locally parabolic,
      // which is exactly what makes this usable as a tuner.
      this.dominantHz = (best + parabolicPeak(this.bins, best)) * this.binHz;
      this.broadbandDb = counted ? 10 * Math.log10(sumPow / counted) : FLOOR_DB;

      const audible = this.dominantDb > FLOOR_DB + 12;
      rDom.set(audible ? fmt(this.dominantHz, 1) : '—',
        audible ? `bin ${best} ±${fmt(this.binHz / 2, 2)} Hz` : 'no peak above the floor');
      rDom.setState(audible ? 'ok' : 'idle');

      const n = audible ? nearestNote(this.dominantHz) : null;
      rNote.set(n ? n.name : '—', n ? `${n.cents >= 0 ? '+' : ''}${n.cents.toFixed(0)} cents · A4 = 440 Hz` : '');
      rNote.setState(n ? (Math.abs(n.cents) < 5 ? 'ok' : Math.abs(n.cents) < 25 ? 'warn' : 'bad') : 'idle');

      rLevel.set(fmt(this.dominantDb, 1));
      rLevel.setState(this.dominantDb > -6 ? 'bad' : this.dominantDb > -60 ? 'ok' : 'idle');
      rBroad.set(fmt(this.broadbandDb, 1));
      rBin.set(fmt(this.binHz, 3), `${FFT_SIZE}-point FFT`);
      rRate.set(String(this.sampleRate), `nyquist ${fmt(this.sampleRate / 2000, 1)} kHz`);
      rInput.set(this.inputRms > 0 ? this.inputRms.toExponential(2) : '0',
        this.inputRms > 0 ? `${fmt(20 * Math.log10(this.inputRms), 1)} dBFS · ctx ${ctx.state}` : `no samples · ctx ${ctx.state}`);
      rInput.setState(this.inputRms > 1e-5 ? 'ok' : this.inputRms > 0 ? 'warn' : 'bad');

      specCap.textContent = `${MIN_HZ} HZ – ${fmt(this.sampleRate / 2000, 1)} KHZ · ${FLOOR_DB} TO ${CEIL_DB} dBFS`;
      this.drawSpectrum(spec);
    });
  }

  /** Log-frequency X axis — a linear axis wastes 90% of the width on treble. */
  private drawSpectrum(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const col = theme();
    const w = c.width, h = c.height;
    if (!w || !h || !this.binHz) return;
    ctx.clearRect(0, 0, w, h);

    const maxHz = this.sampleRate / 2;
    const logMin = Math.log10(MIN_HZ);
    const logMax = Math.log10(maxHz);
    const xOf = (hz: number) => ((Math.log10(Math.max(hz, MIN_HZ)) - logMin) / (logMax - logMin)) * w;
    const yOf = (db: number) =>
      h - 16 - ((Math.max(db, FLOOR_DB) - FLOOR_DB) / (CEIL_DB - FLOOR_DB)) * (h - 24);

    // Decade + octave gridlines
    ctx.font = "9px ui-monospace, monospace";
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const hz of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      if (hz > maxHz) break;
      const x = xOf(hz);
      ctx.strokeStyle = col.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 16); ctx.stroke();
      ctx.fillStyle = col.dimmer;
      const label = hz >= 1000 ? `${hz / 1000}k` : String(hz);
      // Keep the first and last labels fully on canvas.
      const halfW = ctx.measureText(label).width / 2;
      ctx.fillText(label, Math.min(Math.max(x, halfW + 2), w - halfW - 2), h - 13);
    }
    // dB gridlines
    ctx.textAlign = 'left';
    for (let db = CEIL_DB; db > FLOOR_DB + 10; db -= 20) {
      const y = yOf(db);
      ctx.strokeStyle = col.plot;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillStyle = col.gridMid;
      ctx.fillText(`${db}`, 3, y + 1);
    }

    const minBin = Math.max(1, Math.floor(MIN_HZ / this.binHz));

    // Peak-hold trace behind the live trace.
    if (this.peakHold) {
      ctx.beginPath();
      let started = false;
      for (let i = minBin; i < this.peaks.length; i++) {
        const x = xOf(i * this.binHz);
        const y = yOf(this.peaks[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = alpha(col.dark2, 0.33);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Live trace, filled.
    ctx.beginPath();
    ctx.moveTo(xOf(minBin * this.binHz), h - 16);
    for (let i = minBin; i < this.bins.length; i++) {
      ctx.lineTo(xOf(i * this.binHz), yOf(this.bins[i]));
    }
    ctx.lineTo(w, h - 16);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, alpha(col.frame, 0.8));
    grad.addColorStop(1, alpha(col.dark1, 0));
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = col.light1;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Dominant-frequency cursor
    if (this.dominantDb > FLOOR_DB + 12) {
      const x = xOf(this.dominantHz);
      ctx.strokeStyle = col.ok;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 16); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

function nearestNote(hz: number): { name: string; cents: number } | null {
  if (!(hz > 0)) return null;
  const semisFromA4 = 12 * Math.log2(hz / 440);
  const nearest = Math.round(semisFromA4);
  const cents = (semisFromA4 - nearest) * 100;
  // MIDI 69 is A4; index into the name table from C.
  const midi = 69 + nearest;
  if (midi < 12 || midi > 127) return null;
  const name = `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
  return { name, cents };
}

function micErrorHtml(err: AudioUnavailableError): string {
  const base = `<strong>Microphone unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base +
      '<ul>' +
      '<li><strong>Safari</strong> — Settings → Safari → Microphone, or clear this site\'s website data and reload.</li>' +
      '<li><strong>Chrome / Edge</strong> — in-app Settings → Site Settings → Microphone. Also check Settings → Privacy &amp; Security → Microphone allows the browser app itself.</li>' +
      '</ul>';
  }
  if (err.reason === 'no-context') {
    return base + ' Reload and complete the boot gate.';
  }
  return base;
}
