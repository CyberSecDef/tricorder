/**
 * Instrument 3 — Compass / attitude (§8.3).
 *
 * Heading comes from webkitCompassHeading (WebKit-only, present in all three
 * iOS browsers). Pitch and roll come from the gravity vector rather than raw
 * beta/gamma, which is markedly more stable. Heading is smoothed with a
 * CIRCULAR EMA — averaging degrees glitches badly across the 0/360 seam.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, autoCanvas, fmt, section, notice } from '../ui/dom';
import { orientation } from '../sensors/orientation';
import { gravity, calibration } from '../sensors/gravity';
import { CircularEMA, RAD, wrap360 } from '../lib/vec';
import { capabilities } from '../lib/capabilities';

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class CompassInstrument extends Instrument {
  readonly id = 'compass';
  readonly title = 'Compass / Attitude';
  override readonly subtitle = 'Magnetic heading · pitch · roll';
  override readonly resources = 'orientation + motion';

  private headingEMA = new CircularEMA();
  private heading: number | null = null;
  private rawHeading: number | null = null;
  private accuracy: number | null = null;
  private pitch = 0;
  private roll = 0;
  private settled = false;

  protected build(root: HTMLElement): void {
    const caps = capabilities();

    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    if (!caps.compass) {
      append(
        scroll,
        notice(
          'bad',
          'webkitCompassHeading is not present on this engine. Heading is unavailable; the attitude readouts below still work.',
        ),
      );
    }

    // --- Compass rose -----------------------------------------------------
    const rose = autoCanvas();
    const roseBox = el('div', { class: 'scope scope--square' }, rose.node);
    const roseCap = el('div', { class: 'scope__cap', text: '' });
    append(roseBox, roseCap);
    append(scroll, roseBox);

    // --- Readouts ---------------------------------------------------------
    const rHeading = readout('Heading', { unit: '°', note: '' });
    const rCardinal = readout('Bearing', { note: '' });
    const rAccuracy = readout('Heading accuracy', { unit: '°', note: 'webkitCompassAccuracy' });
    const rPitch = readout('Pitch', { unit: '°', note: 'screen axis above horizontal' });
    const rRoll = readout('Roll', { unit: '°', note: '0 = flat, ±180 = face down' });
    const rG = readout('Gravity vector', { unit: 'm/s²', note: '' });

    append(
      scroll,
      section('Bearing'),
      el('div', { class: 'grid' }, rHeading.node, rCardinal.node, rAccuracy.node),
      section('Attitude'),
      el('div', { class: 'grid' }, rPitch.node, rRoll.node, rG.node),
    );

    // --- Bubble level -----------------------------------------------------
    const bubble = autoCanvas();
    const bubbleBox = el('div', { class: 'scope scope--square', style: 'max-width:min(100%,300px)' }, bubble.node);
    append(bubbleBox, el('div', { class: 'scope__cap', text: 'BUBBLE LEVEL' }));
    append(scroll, section('Level'), bubbleBox);

    const cal = calibration();
    append(
      scroll,
      notice(
        cal.verified ? 'ok' : 'warn',
        cal.verified
          ? `Gravity sign convention calibrated on this device (sign ${cal.sign > 0 ? '+1' : '−1'}). Pitch and roll are trustworthy.`
          : 'Gravity sign convention is <strong>assumed, not measured</strong>. Pitch/roll polarity may be inverted. Run Diagnostics → Calibrate gravity, and check the bubble against a real spirit level.',
      ),
    );

    // --- Streams ----------------------------------------------------------
    this.sub(orientation, (o) => {
      this.rawHeading = o.heading;
      this.accuracy = o.headingAccuracy;
      if (o.heading !== null) {
        // ~0.18 alpha at the ~60 Hz orientation rate: responsive but steady.
        this.heading = this.headingEMA.update(o.heading, 0.18);
      }
    });

    this.sub(gravity, (g) => {
      this.pitch = g.pitch;
      this.roll = g.roll;
      this.settled = g.settled;
      rG.set(`${fmt(g.magnitude, 2)}`, `x ${fmt(g.down.x, 2)}  y ${fmt(g.down.y, 2)}  z ${fmt(g.down.z, 2)} (unit, down)`);
      rG.setState(g.settled ? 'ok' : 'warn');
    });

    // --- Render -----------------------------------------------------------
    this.loop(() => {
      rose.resize();
      bubble.resize();

      const h = this.heading;
      rHeading.set(
        h === null ? '—' : fmt(h, 1),
        this.rawHeading === null ? 'no compass' : `raw ${fmt(this.rawHeading, 1)}° · circular EMA α=0.18`,
      );
      rHeading.setState(h === null ? 'idle' : 'ok');
      rCardinal.set(h === null ? '—' : CARDINALS[Math.round(wrap360(h) / 45) % 8]);

      const a = this.accuracy;
      if (a === null) {
        rAccuracy.set('—', 'not reported');
        rAccuracy.setState('idle');
      } else if (a < 0) {
        // Negative means invalid/uncalibrated — the key extra signal for
        // Instrument 7, and worth surfacing honestly here too.
        rAccuracy.set('INVALID', `raw ${fmt(a, 0)} — needs calibration (figure-eight)`);
        rAccuracy.setState('bad');
      } else {
        rAccuracy.set(`±${fmt(a, 0)}`, a <= 15 ? 'good' : a <= 35 ? 'degraded' : 'poor — ferrous interference?');
        rAccuracy.setState(a <= 15 ? 'ok' : a <= 35 ? 'warn' : 'bad');
      }

      rPitch.set(fmt(this.pitch, 1));
      rRoll.set(fmt(this.roll, 1));
      const level = Math.abs(this.pitch) < 1 && Math.abs(this.roll) < 1;
      rPitch.setState(this.settled ? (level ? 'ok' : 'warn') : 'idle');
      rRoll.setState(this.settled ? (level ? 'ok' : 'warn') : 'idle');

      roseCap.textContent = h === null ? 'NO HEADING' : `COHERENCE ${(this.headingEMA.coherence * 100).toFixed(0)}%`;

      this.drawRose(rose, h, a);
      this.drawBubble(bubble, this.pitch, this.roll);
    });
  }

  /** North-up card that rotates under a fixed lubber line, as a real compass does. */
  private drawRose(c: ReturnType<typeof autoCanvas>, heading: number | null, accuracy: number | null): void {
    const { ctx } = c;
    const w = c.width, h = c.height;
    if (!w || !h) return;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 8;

    ctx.clearRect(0, 0, w, h);

    // Confidence ring: arc width proportional to webkitCompassAccuracy.
    if (heading !== null && accuracy !== null && accuracy > 0) {
      const halfArc = Math.min(accuracy, 90) * RAD;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 4, -Math.PI / 2 - halfArc, -Math.PI / 2 + halfArc);
      ctx.strokeStyle = accuracy <= 15 ? '#66cc88' : accuracy <= 35 ? '#ffcc00' : '#ff5555';
      ctx.lineWidth = 5;
      ctx.lineCap = 'butt';
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(cx, cy);
    // Rotate the card so the current heading sits at the top.
    if (heading !== null) ctx.rotate(-heading * RAD);

    // Ticks
    for (let deg = 0; deg < 360; deg += 5) {
      const major = deg % 45 === 0;
      const mid = deg % 15 === 0;
      const inner = R - (major ? 16 : mid ? 10 : 6);
      const a = (deg - 90) * RAD;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
      ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
      ctx.strokeStyle = major ? '#ff9c00' : mid ? '#cc99cc' : '#3a3a48';
      ctx.lineWidth = major ? 2.5 : 1.4;
      ctx.stroke();
    }

    // Cardinal letters, counter-rotated so they stay upright.
    ctx.font = `700 ${Math.max(11, R * 0.15)}px 'Antonio', 'Arial Narrow', sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < 8; i++) {
      const deg = i * 45;
      const a = (deg - 90) * RAD;
      const r = R - 30;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      ctx.save();
      ctx.translate(x, y);
      if (heading !== null) ctx.rotate(heading * RAD);
      ctx.fillStyle = deg === 0 ? '#ff5555' : i % 2 === 0 ? '#ffcc66' : '#9999ff';
      ctx.fillText(CARDINALS[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();

    // Fixed lubber line + heading text.
    ctx.beginPath();
    ctx.moveTo(cx, cy - R - 2);
    ctx.lineTo(cx - 7, cy - R + 13);
    ctx.lineTo(cx + 7, cy - R + 13);
    ctx.closePath();
    ctx.fillStyle = '#ff9c00';
    ctx.fill();

    ctx.font = `700 ${Math.max(20, R * 0.34)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = heading === null ? '#555' : '#ffcc66';
    ctx.fillText(heading === null ? '---' : `${Math.round(wrap360(heading)).toString().padStart(3, '0')}°`, cx, cy);
  }

  /** Two-axis bubble. Deflection is clamped to ±30° so small tilts read clearly. */
  private drawBubble(c: ReturnType<typeof autoCanvas>, pitch: number, roll: number): void {
    const { ctx } = c;
    const w = c.width, h = c.height;
    if (!w || !h) return;
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) / 2 - 10;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = '#3a3a48';
    ctx.lineWidth = 1.5;
    for (const f of [1, 2 / 3, 1 / 3]) {
      ctx.beginPath();
      ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();

    const RANGE = 30;
    const nx = Math.max(-1, Math.min(1, roll / RANGE));
    const ny = Math.max(-1, Math.min(1, -pitch / RANGE));
    const bx = cx + nx * R;
    const by = cy + ny * R;

    const level = Math.abs(pitch) < 1 && Math.abs(roll) < 1;
    ctx.beginPath();
    ctx.arc(bx, by, 13, 0, Math.PI * 2);
    ctx.fillStyle = level ? '#66cc88' : '#ff9c00';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = "10px ui-monospace, monospace";
    ctx.fillStyle = '#9a8f80';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`±${RANGE}° FULL SCALE`, 8, 8);
  }
}

