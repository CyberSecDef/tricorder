/**
 * Barcode & QR scanner.
 *
 * Not in the original handoff — added because it is genuinely useful and the
 * hardware supports it. §12 lists `BarcodeDetector` as one of the APIs iOS does
 * not provide, which is still true, so decoding is done with ZXing compiled to
 * WebAssembly. One code path for every browser, and it reads considerably more
 * symbologies than BarcodeDetector does anyway.
 *
 * THE DESIGN CONSTRAINT: this instrument shows, and never acts.
 *
 * A scanned payload is text supplied by whoever printed the code, which makes
 * it untrusted input in the most literal sense — a stranger's data, rendered on
 * your screen, in a context where people are conditioned to tap without
 * reading. So:
 *
 *   - nothing is ever navigated to, fetched, or executed;
 *   - no link is ever created, not even a disabled one;
 *   - the payload is written with `textContent`, never `innerHTML`;
 *   - invisible and bidirectional characters are made visible, because a
 *     character that changes how the rest of the string renders defeats the
 *     entire point of showing it;
 *   - the analysis says plainly what the payload would do if it were acted on.
 *
 * Copy to clipboard is offered, because that is user-initiated and inert.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireCamera, CameraUnavailableError, type CameraHandle } from '../sensors/camera';
import { analyse, makeVisible, type PayloadAnalysis } from '../lib/payload';

/** Decode at this resolution — plenty for a code filling a third of the frame. */
const SCAN_W = 640;
/** Interval between decode attempts, ms. Decoding is cheap; the camera is not. */
const SCAN_MS = 160;
/** Scans kept in the session list. */
const HISTORY = 8;

interface Scan { text: string; format: string; at: number; analysis: PayloadAnalysis }

export class ScannerInstrument extends Instrument {
  readonly id = 'scanner';
  readonly title = 'Barcode / QR Scanner';
  override readonly subtitle = 'Reads and reports — never opens';
  override readonly resources = 'camera';

  private cam: CameraHandle | null = null;
  private reader: ((img: ImageData) => Promise<any[]>) | null = null;
  private work = document.createElement('canvas');
  private scanning = false;
  private current: Scan | null = null;
  private history: Scan[] = [];
  private corners: Array<{ x: number; y: number }> | null = null;
  private frameW = 0;
  private frameH = 0;
  private error: string | null = null;

  protected async build(root: HTMLElement): Promise<void> {
    const stage = el('div', { class: 'rf' });
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, stage, scroll);
    const statusBox = el('div');
    append(scroll, statusBox);

    try {
      this.cam = await acquireCamera();
    } catch (e) {
      append(statusBox, notice('bad', cameraErrorHtml(e as CameraUnavailableError)));
      return;
    }
    if (!this.isMounted) { this.cam.release(); return; }
    this.onCleanup(() => { this.scanning = false; this.cam?.release(); });

    const video = this.cam.video;
    video.className = 'rf__video';
    const overlay = el('canvas', { class: 'rf__overlay' });
    append(stage, video, overlay);
    const octx = overlay.getContext('2d')!;

    this.work.width = SCAN_W;

    // --- decoder ----------------------------------------------------------
    try {
      const zx = await import('zxing-wasm/reader');
      // Self-hosted, like the ONNX runtime. No CDN, works offline, and no
      // chance of a version mismatch between the JS and its binary.
      zx.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? `${import.meta.env.BASE_URL}zxing/${path}` : prefix + path,
        },
      });
      this.reader = (img: ImageData) => zx.readBarcodes(img, {
        tryHarder: true,
        maxNumberOfSymbols: 1,
      });
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
    if (!this.isMounted) return;

    // --- torch ------------------------------------------------------------
    // Worth having here specifically: a code on a curved or matte surface in
    // poor light is the normal failure, and this is the one instrument where
    // torch earns its place. Feature-detected, and simply absent if the track
    // does not offer it.
    let torchOn = false;
    const btnTorch = el('button', { class: 'btn btn--alt', type: 'button' }, 'Torch');
    btnTorch.addEventListener('click', async () => {
      if (!this.cam?.torch) return;
      torchOn = !torchOn;
      try {
        await this.cam.torch(torchOn);
        btnTorch.textContent = torchOn ? 'Torch: on' : 'Torch';
        btnTorch.className = `btn${torchOn ? '' : ' btn--alt'}`;
      } catch { btnTorch.textContent = 'Torch unavailable'; }
    });
    this.onCleanup(() => { if (torchOn) this.cam?.torch?.(false).catch(() => {}); });

    const btnClear = el('button', { class: 'btn btn--warn', type: 'button' }, 'Clear');
    btnClear.addEventListener('click', () => { this.current = null; this.history = []; renderResult(); });

    append(scroll, el('div', { class: 'btn-row' },
      ...(this.cam.torch ? [btnTorch] : []), btnClear));

    // --- result -----------------------------------------------------------
    const resultBox = el('div');
    const histBox = el('div');
    append(scroll, section('Scanned'), resultBox, section('This session'), histBox);

    const btnCopy = el('button', { class: 'btn', type: 'button' }, 'Copy raw text');

    const renderResult = () => {
      clear(resultBox);
      clear(histBox);
      const s = this.current;
      if (!s) {
        append(resultBox, el('div', { class: 'dim mono', style: 'font-size:12px',
          text: 'Point the camera at a barcode or QR code.' }));
      } else {
        const a = s.analysis;

        // Payload first, and as text. NEVER innerHTML, and never a link: this
        // string came off a stranger's sticker.
        const pre = el('div', { class: 'scan__payload' });
        pre.textContent = makeVisible(s.text);
        append(resultBox,
          el('div', { class: 'grid' },
            kv('Type', a.label), kv('Symbology', s.format), kv('Length', `${s.text.length} chars`)),
          el('div', { class: 'sect' },
            el('div', { class: 'sect__label', text: 'Raw contents' }),
            el('div', { class: 'sect__rule' })),
          pre);

        if (a.fields.length) {
          const t = el('table', { class: 'dtable' });
          const b = el('tbody');
          for (const [k, v] of a.fields) {
            const tr = el('tr', {}, el('td', { text: k }), el('td'));
            (tr.lastChild as HTMLElement).textContent = makeVisible(v);
            append(b, tr);
          }
          append(t, b);
          append(resultBox, t);
        }

        for (const w of a.warnings) {
          const n = el('div', { class: 'notice notice--bad' });
          n.textContent = w;
          append(resultBox, n);
        }

        append(resultBox,
          notice('ok', '<strong>Nothing was opened.</strong> This instrument decodes and describes; it does not navigate, fetch, or run anything, and it deliberately does not turn addresses into links. If you want to act on this, copy it and paste it somewhere you trust.'),
          el('div', { class: 'btn-row' }, btnCopy));
      }

      for (const h of this.history) {
        const row = el('div', { class: 'scan__hist' });
        const label = el('span', { class: 'dim', text: `${h.format} · ` });
        const body = el('span');
        body.textContent = makeVisible(h.text).slice(0, 80);
        append(row, label, body);
        append(histBox, row);
      }
      if (!this.history.length) {
        append(histBox, el('div', { class: 'dim mono', style: 'font-size:11px', text: 'No scans yet.' }));
      }
    };

    btnCopy.addEventListener('click', async () => {
      if (!this.current) return;
      const original = btnCopy.textContent;
      try { await navigator.clipboard.writeText(this.current.text); btnCopy.textContent = 'Copied'; }
      catch { btnCopy.textContent = 'Clipboard blocked'; }
      setTimeout(() => { btnCopy.textContent = original; }, 1600);
    });

    renderResult();

    append(scroll, notice('warn',
      '<strong>Why there is no "open" button.</strong> A printed code is an instruction from whoever printed it, and the whole trick of a malicious one is that people scan and tap in a single motion without ever seeing the address. ' +
      'Everything here is shown as inert text, with invisible and direction-changing characters made visible, so what you read is what is actually there.'));

    // --- scan loop ---------------------------------------------------------
    this.scanning = true;
    void this.scanLoop(() => renderResult());

    this.loop(() => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(1, Math.round(r.width * dpr));
      const ch = Math.max(1, Math.round(r.height * dpr));
      if (overlay.width !== cw || overlay.height !== ch) { overlay.width = cw; overlay.height = ch; }
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (this.error && statusBox.childElementCount === 0) {
        append(statusBox, notice('bad',
          `<strong>Decoder failed to load.</strong> ${escapeHtml(this.error)}`));
      }
      this.drawOverlay(octx, r.width, r.height);
    });
  }

  private async scanLoop(onResult: () => void): Promise<void> {
    const ctx = this.work.getContext('2d', { willReadFrequently: true })!;
    while (this.scanning && this.isMounted) {
      if (document.visibilityState !== 'visible' || !this.reader || !this.cam) { await sleep(250); continue; }
      const video = this.cam.video;
      if (!video.videoWidth) { await sleep(150); continue; }

      const h = Math.round((video.videoHeight / video.videoWidth) * SCAN_W);
      if (this.work.height !== h) this.work.height = h;
      this.frameW = SCAN_W; this.frameH = h;

      try {
        ctx.drawImage(video, 0, 0, SCAN_W, h);
        const img = ctx.getImageData(0, 0, SCAN_W, h);
        const results = await this.reader(img);
        if (!this.isMounted) return;

        const r = results?.[0];
        if (r && typeof r.text === 'string' && r.text.length) {
          this.corners = cornersOf(r);
          if (r.text !== this.current?.text) {
            const scan: Scan = {
              text: r.text,
              format: String(r.format ?? 'unknown'),
              at: Date.now(),
              analysis: analyse(r.text),
            };
            this.current = scan;
            this.history = [scan, ...this.history.filter((x) => x.text !== scan.text)].slice(0, HISTORY);
            onResult();
            if (navigator.vibrate) navigator.vibrate(30);   // absent on iOS; degrade silently
          }
        } else {
          this.corners = null;
        }
      } catch {
        this.corners = null;
      }
      await sleep(SCAN_MS);
    }
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.clearRect(0, 0, w, h);

    // Aiming guide.
    const s = Math.min(w, h) * 0.6;
    ctx.strokeStyle = this.corners ? '#66cc88' : '#ff9c0066';
    ctx.lineWidth = 2;
    const x0 = (w - s) / 2, y0 = (h - s) / 2, c = s * 0.18;
    for (const [ax, ay, bx, by, cx, cy] of [
      [x0, y0 + c, x0, y0, x0 + c, y0],
      [w - x0 - c, y0, w - x0, y0, w - x0, y0 + c],
      [x0, h - y0 - c, x0, h - y0, x0 + c, h - y0],
      [w - x0 - c, h - y0, w - x0, h - y0, w - x0, h - y0 - c],
    ]) {
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.stroke();
    }

    // Outline the detected symbol, mapped through the same object-fit: cover
    // geometry the rangefinder uses.
    if (this.corners && this.frameW && this.frameH) {
      const scale = Math.max(w / this.frameW, h / this.frameH);
      const offX = (w - this.frameW * scale) / 2;
      const offY = (h - this.frameH * scale) / 2;
      ctx.beginPath();
      this.corners.forEach((p, i) => {
        const x = p.x * scale + offX, y = p.y * scale + offY;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = '#66cc88';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}

/** ZXing reports corner points; be tolerant about the exact shape. */
function cornersOf(r: any): Array<{ x: number; y: number }> | null {
  const p = r?.position;
  if (!p) return null;
  const pts = [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft]
    .filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y));
  return pts.length === 4 ? pts : null;
}

function kv(label: string, value: string) {
  const r = readout(label, { note: '' });
  r.set(value);
  return r.node;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function cameraErrorHtml(err: CameraUnavailableError): string {
  const base = `<strong>Camera unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base + ' Check the site\'s camera permission, and that Settings &rarr; Privacy &amp; Security &rarr; Camera allows the browser itself.';
  }
  return base;
}
