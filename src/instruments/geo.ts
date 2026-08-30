/**
 * Instrument 2 — Geo & navigation (§8.2).
 *
 * Position, accuracy, altitude, speed, GPS heading, plus a session track log
 * with haversine distance. `heading` and `speed` are null when stationary
 * because they are GPS-derived, so heading falls back to the compass.
 *
 * Acceptance: walk 100 m — the logged distance should land within ~10%.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice, escapeHtml } from '../ui/dom';
import { geo, geoError, fixQuality, toDMS, type GeoSample } from '../sensors/geo';
import { orientation } from '../sensors/orientation';
import { haversine } from '../lib/dsp';
import { wrap360 } from '../lib/vec';

interface TrackPoint { lat: number; lon: number; acc: number; t: number }

/**
 * Reject fixes that would add distance the GPS cannot actually resolve.
 * Without this, a stationary phone accumulates hundreds of metres of drift
 * and the 100 m acceptance test fails badly.
 */
const MAX_USABLE_ACCURACY = 30;   // metres — ignore fixes coarser than this
const MIN_STEP_FACTOR = 0.5;      // step must exceed this × the accuracy radius

export class GeoInstrument extends Instrument {
  readonly id = 'geo';
  readonly title = 'Geo & Navigation';
  override readonly subtitle = 'GNSS position · track log';
  override readonly resources = 'geolocation';

  private track: TrackPoint[] = [];
  private distance = 0;
  private rejected = 0;
  private last: GeoSample | null = null;
  private compassHeading: number | null = null;
  private startedAt = Date.now();

  protected build(root: HTMLElement): void {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    const errBox = el('div');
    append(scroll, errBox);

    const rLat = readout('Latitude', { note: '' });
    const rLon = readout('Longitude', { note: '' });
    const rAcc = readout('Fix accuracy', { unit: 'm', note: '68% confidence radius' });
    const rQual = readout('Fix quality', { note: '' });
    const rAlt = readout('Altitude', { unit: 'm', note: 'GNSS altitude — unreliable, ±10–30 m' });
    const rSpeed = readout('Speed', { unit: 'm/s', note: '' });
    const rHead = readout('Course', { unit: '°', note: '' });
    const rAge = readout('Fix age', { unit: 's', note: '' });

    append(
      scroll,
      section('Position'),
      el('div', { class: 'grid' }, rLat.node, rLon.node),
      el('div', { class: 'grid' }, rAcc.node, rQual.node, rAlt.node),
      section('Motion'),
      el('div', { class: 'grid' }, rSpeed.node, rHead.node, rAge.node),
    );

    // --- Track plot -------------------------------------------------------
    const plot = autoCanvas();
    const plotBox = el('div', { class: 'scope', style: 'height:min(38dvh,300px)' }, plot.node);
    const plotCap = el('div', { class: 'scope__cap', text: 'TRACK' });
    append(plotBox, plotCap);

    const rDist = readout('Track distance', { unit: 'm', note: 'haversine, drift-filtered' });
    const rPts = readout('Track points', { note: '' });
    const rElapsed = readout('Session', { note: '' });

    const btnReset = el('button', { class: 'btn btn--warn', type: 'button' }, 'Reset track');
    btnReset.addEventListener('click', () => {
      this.track = [];
      this.distance = 0;
      this.rejected = 0;
      this.startedAt = Date.now();
    });

    const btnExport = el('button', { class: 'btn btn--alt', type: 'button' }, 'Copy GeoJSON');
    btnExport.addEventListener('click', () => void this.exportTrack(btnExport));

    append(
      scroll,
      section('Track log'),
      el('div', { class: 'grid' }, rDist.node, rPts.node, rElapsed.node),
      plotBox,
      el('div', { class: 'btn-row' }, btnReset, btnExport),
      notice(
        'warn',
        `Fixes coarser than <strong>${MAX_USABLE_ACCURACY} m</strong>, or steps shorter than half the accuracy radius, are discarded rather than integrated — otherwise a stationary phone accumulates hundreds of metres of GNSS drift. Altitude is shown because the API reports it, but it is not trustworthy.`,
      ),
    );

    // --- Streams ----------------------------------------------------------
    this.sub(orientation, (o) => { this.compassHeading = o.heading; });

    this.sub(geo, (p) => {
      this.last = p;
      this.ingest(p);
    });

    // --- Render -----------------------------------------------------------
    this.loop(() => {
      plot.resize();

      const err = geoError();
      renderError(errBox, err);

      const p = this.last;
      if (p) {
        rLat.set(fmt(p.latitude, 6), toDMS(p.latitude, 'lat'));
        rLon.set(fmt(p.longitude, 6), toDMS(p.longitude, 'lon'));

        const q = fixQuality(p.accuracy);
        rAcc.set(fmt(p.accuracy, 1));
        rAcc.setState(q.level >= 2 ? 'ok' : q.level === 1 ? 'warn' : 'bad');
        rQual.set(q.label, `${'▮'.repeat(q.level + 1)}${'▯'.repeat(3 - q.level)}`);
        rQual.setState(q.level >= 2 ? 'ok' : q.level === 1 ? 'warn' : 'bad');

        rAlt.set(p.altitude === null ? '—' : fmt(p.altitude, 1),
          p.altitudeAccuracy === null ? 'no altitude accuracy reported' : `±${fmt(p.altitudeAccuracy, 0)} m — unreliable`);
        rAlt.setState(p.altitude === null ? 'idle' : 'warn');

        if (p.speed === null) {
          rSpeed.set('—', 'null while stationary (GNSS-derived)');
          rSpeed.setState('idle');
        } else {
          rSpeed.set(fmt(p.speed, 2), `${fmt(p.speed * 3.6, 1)} km/h`);
          rSpeed.setState('ok');
        }

        if (p.heading !== null) {
          rHead.set(fmt(wrap360(p.heading), 1), 'GNSS course over ground');
          rHead.setState('ok');
        } else if (this.compassHeading !== null) {
          rHead.set(fmt(wrap360(this.compassHeading), 1), 'compass fallback — GNSS course null');
          rHead.setState('warn');
        } else {
          rHead.set('—', 'no course, no compass');
          rHead.setState('idle');
        }

        const age = (Date.now() - p.timestamp) / 1000;
        rAge.set(fmt(age, 1));
        rAge.setState(age < 5 ? 'ok' : age < 20 ? 'warn' : 'bad');
      } else if (!err) {
        rQual.set('ACQUIRING', 'waiting for first fix');
        rQual.setState('idle');
      }

      rDist.set(fmt(this.distance, 1), `${fmt(this.distance / 1000, 3)} km · ${this.rejected} fixes rejected`);
      rPts.set(String(this.track.length));
      const elapsed = (Date.now() - this.startedAt) / 1000;
      rElapsed.set(formatDuration(elapsed), this.distance > 1 && elapsed > 1
        ? `avg ${fmt(this.distance / elapsed, 2)} m/s`
        : '');

      plotCap.textContent = this.track.length
        ? `TRACK · ${this.track.length} PTS · ${fmt(this.distance, 0)} M`
        : 'TRACK · NO DATA';
      this.drawTrack(plot);
    });
  }

  /** Add a fix to the track if it is good enough to represent real movement. */
  private ingest(p: GeoSample): void {
    if (p.accuracy > MAX_USABLE_ACCURACY) { this.rejected++; return; }

    const prev = this.track[this.track.length - 1];
    if (!prev) {
      this.track.push({ lat: p.latitude, lon: p.longitude, acc: p.accuracy, t: p.timestamp });
      return;
    }

    const step = haversine(prev.lat, prev.lon, p.latitude, p.longitude);
    // A step smaller than the fix uncertainty is indistinguishable from noise.
    if (step < Math.max(1, p.accuracy * MIN_STEP_FACTOR)) { this.rejected++; return; }

    this.distance += step;
    this.track.push({ lat: p.latitude, lon: p.longitude, acc: p.accuracy, t: p.timestamp });
    // Keep memory bounded on a long walk; the distance total is already banked.
    if (this.track.length > 5000) this.track.splice(0, 1000);
  }

  /** Equirectangular projection — adequate over a session-sized track. */
  private drawTrack(c: ReturnType<typeof autoCanvas>): void {
    const { ctx } = c;
    const w = c.width, h = c.height;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);

    if (this.track.length < 2) {
      ctx.fillStyle = '#3a3a48';
      ctx.font = "11px ui-monospace, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(this.track.length ? 'AWAITING MOVEMENT' : 'NO FIX', w / 2, h / 2);
      return;
    }

    const lat0 = this.track[0].lat;
    const kx = Math.cos((lat0 * Math.PI) / 180);
    const xs = this.track.map((p) => p.lon * kx);
    const ys = this.track.map((p) => p.lat);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 18;
    const spanX = Math.max(maxX - minX, 1e-7);
    const spanY = Math.max(maxY - minY, 1e-7);
    const s = Math.min((w - pad * 2) / spanX, (h - pad * 2) / spanY);
    const ox = (w - spanX * s) / 2 - minX * s;
    const oy = (h - spanY * s) / 2 + maxY * s;
    const px = (i: number) => xs[i] * s + ox;
    const py = (i: number) => oy - ys[i] * s;

    ctx.beginPath();
    for (let i = 0; i < this.track.length; i++) {
      const x = px(i), y = py(i);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffcc66';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Start marker
    ctx.beginPath();
    ctx.arc(px(0), py(0), 4, 0, Math.PI * 2);
    ctx.fillStyle = '#66cc88';
    ctx.fill();

    // Current position with its accuracy radius, drawn to scale.
    const i = this.track.length - 1;
    const accPx = this.track[i].acc * (s / 111320); // metres → degrees → px
    ctx.beginPath();
    ctx.arc(px(i), py(i), Math.max(3, Math.min(accPx, Math.min(w, h) / 2)), 0, Math.PI * 2);
    ctx.strokeStyle = '#3366cc';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px(i), py(i), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff9c00';
    ctx.fill();

    // Scale bar
    const metresPerPx = 111320 / s;
    const barMetres = niceNumber(80 * metresPerPx);
    const barPx = barMetres / metresPerPx;
    ctx.strokeStyle = '#9a8f80';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(10, h - 12); ctx.lineTo(10 + barPx, h - 12);
    ctx.moveTo(10, h - 16); ctx.lineTo(10, h - 8);
    ctx.moveTo(10 + barPx, h - 16); ctx.lineTo(10 + barPx, h - 8);
    ctx.stroke();
    ctx.fillStyle = '#9a8f80';
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${barMetres} m`, 10, h - 16);
  }

  private async exportTrack(btn: HTMLButtonElement): Promise<void> {
    const geojson = {
      type: 'Feature',
      properties: {
        distanceMetres: Math.round(this.distance),
        points: this.track.length,
        startedAt: new Date(this.startedAt).toISOString(),
      },
      geometry: { type: 'LineString', coordinates: this.track.map((p) => [p.lon, p.lat]) },
    };
    const text = JSON.stringify(geojson);
    const original = btn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Clipboard blocked';
    }
    setTimeout(() => { btn.textContent = original; }, 1600);
  }
}

function renderError(box: HTMLElement, err: ReturnType<typeof geoError>): void {
  const key = err ? `${err.kind}:${err.message}` : '';
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren();
  if (!err) return;

  if (err.kind === 'denied') {
    // A page-level denial and an OS-level app denial are indistinguishable
    // from here (§7), so both remedies have to be offered.
    box.appendChild(notice('bad',
      '<strong>Location denied.</strong> Two different things produce this, and the API cannot tell them apart:' +
      '<ul>' +
      '<li><strong>Page-level</strong> — clear this site\'s data and reload to get the prompt back.</li>' +
      '<li><strong>OS-level</strong> — Settings → Privacy &amp; Security → Location Services, and check the <em>browser app itself</em> is allowed. Chrome and Edge need this in addition to the page permission; Safari usually already has it.</li>' +
      '</ul>'));
  } else {
    box.appendChild(notice('warn',
      `<strong>Location ${escapeHtml(err.kind)}.</strong> ${escapeHtml(err.message)}` +
      (err.kind === 'timeout' ? ' Indoors, a first high-accuracy fix can take a while — try near a window.' : '')));
  }
}

function formatDuration(sec: number): string {
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** Round down to 1/2/5 × 10ⁿ for a legible scale bar. */
function niceNumber(v: number): number {
  const exp = Math.floor(Math.log10(Math.max(v, 1e-6)));
  const base = Math.pow(10, exp);
  const f = v / base;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * base;
}
