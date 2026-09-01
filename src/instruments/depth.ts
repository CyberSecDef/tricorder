/**
 * Instrument 9 — ML depth scanner (§8.9).
 *
 * Monocular depth estimation on live camera frames, via Depth-Anything-V2-small
 * through Transformers.js. §11 q.6 is answered — WebGPU is present in all three
 * browsers on iOS 26.6.1 — so the fast path is the expected route and WASM is a
 * genuine fallback rather than the likely outcome.
 *
 * What this produces is RELATIVE INVERSE DEPTH. Not metres, not even a
 * consistent scale between frames. The model says "this pixel is nearer than
 * that one"; it does not know how far away anything is, and no amount of
 * post-processing changes that. The UI says so plainly.
 *
 * Three things §8.9 warns about, all handled:
 *
 *   1. **Per-frame min/max normalisation causes severe flicker.** The raw
 *      output's range wanders frame to frame, so normalising against it makes
 *      the whole image pulse. The bounds are smoothed with an EMA instead.
 *      This is why we read `predicted_depth` rather than the pipeline's
 *      convenience `depth` image, which is already per-frame normalised.
 *   2. **Inference must be decoupled from rendering.** At single-digit FPS a
 *      render loop that waits for the model would drop the whole UI to the
 *      model's rate. Inference runs its own async loop; the display always
 *      draws the most recent map it has.
 *   3. **The model download is 25–50 MB.** It is therefore explicit, never
 *      automatic, with a progress bar. The Cache API keeps it per-browser, so
 *      trying the app in Safari and Chrome downloads it twice.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireCamera, CameraUnavailableError, type CameraHandle } from '../sensors/camera';
import { TURBO, GRAY } from '../lib/colormap';

const MODEL = 'onnx-community/depth-anything-v2-small';

/**
 * Weight formats, in the order the cycle button offers them.
 *
 * §8.9 recommends `q8`, and that is right for the CPU path — but it is a poor
 * default on a GPU. int8 weights are not natively accelerated, so WebGPU
 * dequantises on the fly and can end up SLOWER than half precision, which is
 * the GPU's native format. Hence a different default per backend, and a
 * selector, because the only way to know what a given phone prefers is to
 * measure it.
 */
const DTYPES = ['fp16', 'q4f16', 'q8', 'fp32'] as const;
type Dtype = (typeof DTYPES)[number];

/**
 * Inference resolution.
 *
 * §8.9 says to downscale before inference, and taking that to mean "hand the
 * pipeline a smaller canvas" is WRONG — it was the first thing tried here and
 * it changed nothing at all. `DPTImageProcessor` resizes whatever it is given
 * to the size in its own config, which for this model is 518×518. A 192 px
 * canvas is upscaled straight back to 518 and inference costs exactly the
 * same. Measured: 192 px and 256 px canvases both produced 500 ms.
 *
 * The resolution that matters is the PROCESSOR's, and it has to be set on the
 * processor after the pipeline is built. DPT also requires a multiple of 14 —
 * its patch size — hence these values rather than round numbers.
 */
const SIZES = [196, 252, 350, 518] as const;   // 14 × {14, 18, 25, 37}
/** The model's own default, for reference in the UI. */
const NATIVE_SIZE = 518;
/** Minimum interval between inferences, ms — caps the loop at ~15 fps. */
const MIN_FRAME_MS = 66;
/** Smoothing for the normalisation bounds. Low and slow — this is the anti-flicker. */
const BOUNDS_ALPHA = 0.08;

export class DepthInstrument extends Instrument {
  readonly id = 'depth';
  readonly title = 'ML Depth Scanner';
  override readonly subtitle = 'Relative inverse depth · not metres';
  override readonly resources = 'camera + GPU';

  private cam: CameraHandle | null = null;
  private pipe: any = null;
  private running = false;
  private loading = false;
  private backend: 'webgpu' | 'wasm' = 'wasm';
  private backendReason = '';

  private dtype: Dtype = 'fp16';
  private inputSize: number = 252;
  private imageData: ImageData | null = null;

  private work = document.createElement('canvas');
  private out = document.createElement('canvas');
  private display: HTMLCanvasElement | null = null;

  private depth: Float32Array | null = null;
  /**
   * Our own copy of the latest depth map.
   *
   * The pipeline's output tensor must be disposed after every inference, and
   * on WebGPU that matters more than it looks: output tensors can be
   * GPU-backed, and GPU memory is not managed by the JavaScript garbage
   * collector. Holding a reference to `tensor.data` and letting the tensor
   * fall out of scope leaks a GPU buffer per frame — at ten frames a second
   * that is how a tab gets killed by WKWebView for memory. So: copy into this
   * reused buffer, then dispose.
   */
  private depthBuf: Float32Array | null = null;
  private depthW = 0;
  private depthH = 0;
  private loEMA: number | null = null;
  private hiEMA: number | null = null;

  private inferMs = 0;
  /**
   * Split timing. "Inference is slow" has at least two very different causes
   * and one number cannot tell them apart: the model itself, or the plumbing
   * around it. `RawImage.fromCanvas` performs a GPU→CPU readback of the video
   * frame every iteration, and on a phone a readback can cost more than people
   * expect. Timing them separately turns a guess into a measurement.
   */
  private prepMs = 0;
  private modelMs = 0;
  private inferCount = 0;
  private fps = 0;
  private lut: Uint8ClampedArray = TURBO;
  private error: string | null = null;

  protected async build(root: HTMLElement): Promise<void> {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    // `'gpu' in navigator` says the API exists, NOT that it works. Headless
    // Chromium advertises it and then fails to produce an adapter, and there is
    // no reason iOS could not do the same on a device or in a context where the
    // GPU is unavailable. Ask for an adapter and believe the answer — getting
    // this wrong means picking a backend that cannot initialise and failing at
    // model-load time with an opaque error, long after the choice was made.
    const picked = await pickBackend();
    this.backend = picked.backend;
    this.backendReason = picked.reason;
    // int8 on a GPU is a false economy; half precision is its native format.
    this.dtype = this.backend === 'webgpu' ? 'fp16' : 'q8';

    const statusBox = el('div');
    append(scroll,
      notice('warn',
        '<strong>This reports relative inverse depth, not distance.</strong> The model can say which pixels are nearer than which; it has no idea how far away anything is, and the scale is not even consistent between frames. ' +
        'For a real distance in metres, use the <strong>Rangefinder</strong> — that one is geometry, not inference.'),
      statusBox);

    // --- camera -----------------------------------------------------------
    try {
      this.cam = await acquireCamera();
    } catch (e) {
      append(statusBox, notice('bad', cameraErrorHtml(e as CameraUnavailableError)));
      return;
    }
    if (!this.isMounted) { this.cam.release(); return; }
    this.onCleanup(() => { this.teardownPipe(); this.cam?.release(); });

    const video = this.cam.video;
    video.className = 'depth__video';
    const canvas = el('canvas', { class: 'depth__out' });
    this.display = canvas;
    append(scroll, el('div', { class: 'depth' }, video, canvas));

    this.work.width = this.inputSize;
    this.work.height = this.inputSize;

    // --- model load -------------------------------------------------------
    const bar = el('div', { class: 'bar__prog' });
    const barWrap = el('div', { class: 'bar__track' }, bar);
    const progLabel = el('div', { class: 'dim mono', style: 'font-size:11px' });
    const btnLoad = el('button', { class: 'btn', type: 'button' }, 'Load model (~25–50 MB)');
    btnLoad.addEventListener('click', () => void this.load(btnLoad, bar, progLabel, statusBox));

    append(scroll, section('Model'),
      el('div', { class: 'btn-row' }, btnLoad), barWrap, progLabel);

    // --- readouts ---------------------------------------------------------
    const rBackend = readout('Backend', { note: '' });
    const rInfer = readout('Inference', { unit: 'ms', note: '' });
    const rFps = readout('Rate', { unit: 'fps', note: '' });
    const rRange = readout('Depth range', { note: 'smoothed normalisation bounds' });

    append(scroll, section('Performance'),
      el('div', { class: 'grid' }, rBackend.node, rInfer.node, rFps.node, rRange.node));

    // --- tuning -----------------------------------------------------------
    const btnDtype = el('button', { class: 'btn btn--alt', type: 'button' }, `Weights: ${this.dtype}`);
    btnDtype.addEventListener('click', () => {
      this.dtype = DTYPES[(DTYPES.indexOf(this.dtype) + 1) % DTYPES.length];
      btnDtype.textContent = `Weights: ${this.dtype}`;
      // A different weight format is a different file, so the model reloads.
      this.teardownPipe();
      btnLoad.disabled = false;
      btnLoad.textContent = `Load ${this.dtype} model`;
    });
    const btnSize = el('button', { class: 'btn btn--alt', type: 'button' }, `Input: ${this.inputSize}px`);
    btnSize.addEventListener('click', () => {
      this.inputSize = SIZES[(SIZES.indexOf(this.inputSize as any) + 1) % SIZES.length];
      this.work.width = this.work.height = this.inputSize;
      this.applyProcessorSize();
      btnSize.textContent = `Input: ${this.inputSize}px${this.inputSize === NATIVE_SIZE ? ' (native)' : ''}`;
    });

    append(scroll, section('Tuning'),
      el('div', { class: 'btn-row' }, btnDtype, btnSize),
      notice('warn',
        '<strong>These are the two levers on frame rate, and the right setting is device-specific.</strong> ' +
        'The Inference readout splits its total into <em>model</em> and <em>frame</em>: model time is the network, frame time is grabbing and converting the camera image. If frame time is the larger share, no amount of weight-format tuning will help and the problem is the plumbing. ' +
        'Weight format: <code>fp16</code> is half precision and is usually fastest on a GPU, because it is what the hardware works in natively; <code>q8</code> is int8 and is usually fastest on the CPU path but can be <em>slower</em> on a GPU, which has to dequantise as it goes. ' +
        `Input size: this sets the <em>processor's</em> target, not just the canvas — handing the pipeline a smaller image does nothing, because it resizes back up to the model's native ${NATIVE_SIZE}px regardless. Values are multiples of 14, the model's patch size. Cost scales roughly with the square, so ${SIZES[0]}px is about ${(NATIVE_SIZE / SIZES[0]) ** 2 | 0}× cheaper than native. Changing the weight format downloads a different file; changing the size is free and applies on the next frame.`));

    const btnMap = el('button', { class: 'btn btn--alt', type: 'button' }, 'Colormap: turbo');
    btnMap.addEventListener('click', () => {
      this.lut = this.lut === TURBO ? GRAY : TURBO;
      btnMap.textContent = `Colormap: ${this.lut === TURBO ? 'turbo' : 'grayscale'}`;
    });
    append(scroll, el('div', { class: 'btn-row' }, btnMap));

    append(scroll, notice('warn',
      '<strong>Why the colours do not jump around.</strong> The raw output\'s range wanders from frame to frame, so normalising each frame against its own minimum and maximum makes the whole image pulse — §8.9 calls this out specifically. The bounds here are smoothed across frames instead, which is why a hand entering the shot changes the picture gradually rather than restaging it. ' +
      'It also means the colours are comparable over a few seconds, and not beyond that.'));

    // --- render -----------------------------------------------------------
    let fpsTick = performance.now();
    this.every(1000, () => {
      const now = performance.now();
      this.fps = this.inferCount / Math.max(0.001, (now - fpsTick) / 1000);
      this.inferCount = 0;
      fpsTick = now;
      // Painted here rather than in the render loop, which pauses when the
      // page is hidden. Updating from the interval means the readout tells the
      // truth about a paused pipeline instead of freezing on its last value
      // and implying work that is not happening.
      rFps.set(this.fps ? fmt(this.fps, 1) : '0.0',
        !this.pipe ? 'model not loaded'
          : document.visibilityState !== 'visible' ? 'paused — page not visible'
          : '');
      rFps.setState(!this.pipe ? 'idle' : this.fps > 0 ? 'ok' : 'warn');
    });

    let lastStatus = '';
    this.loop(() => {
      const status = this.error ? 'error'
        : this.loading ? 'loading'
        : this.pipe ? 'running'
        : 'idle';
      if (status !== lastStatus) {
        lastStatus = status;
        clear(statusBox);
        if (status === 'idle') {
          append(statusBox, notice('warn',
            `<strong>Model not loaded.</strong> It is a ${this.backend === 'webgpu' ? 'WebGPU' : 'WASM'} download of roughly 25–50 MB, so it is never fetched without asking. ` +
            'The browser caches it afterwards — but per browser, so trying this in Safari and Chrome downloads it twice.'));
        } else if (status === 'error') {
          append(statusBox, notice('bad', `<strong>Model failed to load.</strong> ${escapeHtml(this.error ?? '')}`));
        } else if (status === 'running') {
          append(statusBox, notice('ok',
            this.backend === 'webgpu'
              ? '<strong>Running on WebGPU.</strong> Expect roughly 5–15 fps on recent iPhone hardware.'
              : '<strong>Running on the WASM fallback — this will be slow.</strong> WebGPU was not detected, so inference is on the CPU: single-digit fps or worse.'));
        }
      }

      rBackend.set(this.backend.toUpperCase(), this.backendReason);
      rBackend.setState(this.backend === 'webgpu' ? 'ok' : 'warn');
      rInfer.set(this.inferMs ? fmt(this.inferMs, 0) : '—',
        this.inferMs
          ? `model ${fmt(this.modelMs, 0)} + frame ${fmt(this.prepMs, 0)} · ${this.inputSize}px ${this.dtype}`
          : `${this.inputSize}×${this.inputSize} · ${this.dtype}`);
      rRange.set(this.loEMA === null ? '—' : `${fmt(this.loEMA, 2)} … ${fmt(this.hiEMA!, 2)}`,
        'relative inverse depth — unitless');

      this.draw();
    });
  }

  /**
   * Point the image processor at our chosen resolution.
   *
   * Must be set on the processor itself, not only on its config: the resolved
   * `size` is read once at construction (`this.size = config.size ??
   * config.image_size`), so writing config alone has no effect on an
   * already-built pipeline. Both are set, so a processor that re-reads config
   * also behaves.
   */
  private applyProcessorSize(): void {
    const ip = (this.pipe as any)?.processor?.image_processor;
    if (!ip) return;
    const size = { width: this.inputSize, height: this.inputSize };
    try {
      ip.size = size;
      if (ip.config) ip.config.size = size;
    } catch { /* a future version may make these read-only; native size still works */ }
  }

  /** Drop the pipeline and its GPU/WASM session so a reload is a clean start. */
  private teardownPipe(): void {
    this.running = false;
    const p = this.pipe;
    this.pipe = null;
    this.depth = null;
    this.depthBuf = null;
    this.imageData = null;
    this.loEMA = this.hiEMA = null;
    this.inferMs = 0;
    try { p?.dispose?.(); } catch { /* nothing useful to do */ }
  }

  private async load(
    btn: HTMLButtonElement, bar: HTMLElement, label: HTMLElement, statusBox: HTMLElement,
  ): Promise<void> {
    if (this.loading || this.pipe) return;
    this.loading = true;
    this.error = null;
    btn.disabled = true;
    btn.textContent = 'Loading…';

    try {
      // Dynamic import so Transformers.js and the ONNX runtime are a separate
      // chunk: the other nine instruments should not pay 400 kB for a model
      // this screen may never load.
      const { pipeline, RawImage, env } = await import('@huggingface/transformers');

      // Serve the ONNX Runtime binaries ourselves rather than from a CDN. The
      // installed runtime is a dev build whose exact version may not exist on
      // any CDN, and a near-miss version fails at runtime rather than 404ing
      // somewhere you would notice. BASE_URL so a subpath deploy still works.
      const wasmEnv = env.backends?.onnx?.wasm;
      if (wasmEnv) wasmEnv.wasmPaths = `${import.meta.env.BASE_URL}ort/`;

      const files = new Map<string, number>();
      this.pipe = await pipeline('depth-estimation', MODEL, {
        device: this.backend,
        dtype: this.dtype,
        progress_callback: (p: any) => {
          if (p.status === 'progress' && typeof p.progress === 'number') {
            files.set(p.file, p.progress);
            const pct = [...files.values()].reduce((a, b) => a + b, 0) / files.size;
            bar.style.width = `${pct.toFixed(1)}%`;
            label.textContent = `${pct.toFixed(0)}% · ${p.file ?? ''}`;
          } else if (p.status === 'ready') {
            bar.style.width = '100%';
            label.textContent = 'ready';
          }
        },
      } as any);

      this.applyProcessorSize();

      this.loading = false;
      btn.textContent = 'Model loaded';
      clear(statusBox);
      this.running = true;
      void this.inferenceLoop(RawImage);
    } catch (e) {
      this.loading = false;
      this.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      btn.disabled = false;
      btn.textContent = 'Retry loading model';
    }
  }

  /**
   * Inference on its own clock. Never awaited by the render loop — at
   * single-digit fps that would drag the entire UI down to the model's rate.
   */
  private async inferenceLoop(RawImage: any): Promise<void> {
    const ctx = this.work.getContext('2d', { willReadFrequently: true })!;
    while (this.running && this.isMounted && this.pipe && this.cam) {
      // Do not infer into a backgrounded tab. iOS is aggressive about
      // reclaiming memory from hidden pages, and running a camera plus
      // continuous GPU inference while invisible is a good way to be killed —
      // for work nobody can see.
      if (document.visibilityState !== 'visible') { await sleep(250); continue; }

      const video = this.cam.video;
      if (!video.videoWidth) { await sleep(100); continue; }

      const t0 = performance.now();
      try {
        ctx.drawImage(video, 0, 0, this.inputSize, this.inputSize);
        const img = RawImage.fromCanvas(this.work);
        const t1 = performance.now();
        const res: any = await this.pipe(img);
        const t2 = performance.now();
        if (!this.isMounted) return;
        this.prepMs = t1 - t0;
        this.modelMs = t2 - t1;

        const t = res?.predicted_depth;
        if (t?.data && t?.dims?.length >= 2) {
          const h = t.dims[t.dims.length - 2];
          const w = t.dims[t.dims.length - 1];
          const src = t.data as Float32Array;
          if (!this.depthBuf || this.depthBuf.length !== src.length) {
            this.depthBuf = new Float32Array(src.length);
          }
          this.depthBuf.set(src);
          this.depth = this.depthBuf;
          this.depthW = w;
          this.depthH = h;
          this.updateBounds(this.depth);
        }
        // Free the tensor explicitly rather than leaving it to the collector,
        // which does not know about GPU buffers at all.
        for (const key of ['predicted_depth', 'depth']) {
          try { (res as any)?.[key]?.dispose?.(); } catch { /* nothing to do */ }
        }
        this.inferMs = performance.now() - t0;
        this.inferCount++;
      } catch (e) {
        this.error = e instanceof Error ? e.message : String(e);
        this.running = false;
        return;
      }
      // Cap the rate. Beyond about fifteen frames a second there is nothing to
      // see on a depth map, and running flat out just multiplies the
      // per-frame allocation churn and the thermal load for no benefit.
      const spare = MIN_FRAME_MS - (performance.now() - t0);
      await sleep(spare > 0 ? spare : 0);
    }
  }

  /**
   * Smooth the normalisation bounds across frames. This one EMA is the whole
   * difference between a readable depth image and a strobing one.
   */
  private updateBounds(d: Float32Array): void {
    let lo = Infinity, hi = -Infinity;
    // Every 4th sample: the extremes of a depth map are not sparse, and this
    // runs on the inference thread's budget.
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
    this.loEMA = this.loEMA === null ? lo : this.loEMA + (lo - this.loEMA) * BOUNDS_ALPHA;
    this.hiEMA = this.hiEMA === null ? hi : this.hiEMA + (hi - this.hiEMA) * BOUNDS_ALPHA;
  }

  private draw(): void {
    const canvas = this.display;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(r.width * dpr));
    const ch = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }

    const ctx = canvas.getContext('2d')!;
    const d = this.depth;
    if (!d || this.loEMA === null || this.hiEMA === null) {
      ctx.clearRect(0, 0, cw, ch);
      return;
    }

    const w = this.depthW, h = this.depthH;
    if (this.out.width !== w || this.out.height !== h) { this.out.width = w; this.out.height = h; }
    const octx = this.out.getContext('2d')!;
    if (!this.imageData || this.imageData.width !== w || this.imageData.height !== h) {
      this.imageData = octx.createImageData(w, h);
    }
    const img = this.imageData;
    const px = img.data;
    const lo = this.loEMA, span = Math.max(this.hiEMA - lo, 1e-6);
    const lut = this.lut;

    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      let t = (d[i] - lo) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const c = (t * 255) | 0;
      px[p] = lut[c * 3];
      px[p + 1] = lut[c * 3 + 1];
      px[p + 2] = lut[c * 3 + 2];
      px[p + 3] = 255;
    }
    octx.putImageData(img, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this.out, 0, 0, cw, ch);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Choose a backend by actually asking for a GPU adapter.
 *
 * §11 q.6 established that `navigator.gpu` is present in all three browsers on
 * iOS 26, and that is genuinely useful — but presence is not capability. An
 * adapter request can still return null, and then `pipeline(..., {device:
 * 'webgpu'})` fails at load time with "no available backend found", which
 * gives the user no idea that the real problem was a decision made seconds
 * earlier.
 */
async function pickBackend(): Promise<{ backend: 'webgpu' | 'wasm'; reason: string }> {
  const gpu = (navigator as any).gpu;
  if (!gpu) return { backend: 'wasm', reason: 'no navigator.gpu — CPU fallback, slow' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { backend: 'wasm', reason: 'navigator.gpu present but no adapter — CPU fallback' };
    return { backend: 'webgpu', reason: 'GPU adapter acquired' };
  } catch (e) {
    return { backend: 'wasm', reason: `adapter request threw — CPU fallback` };
  }
}

function cameraErrorHtml(err: CameraUnavailableError): string {
  const base = `<strong>Camera unavailable.</strong> ${escapeHtml(err.message)}`;
  if (err.reason === 'denied') {
    return base + ' Check the site\'s camera permission, and that Settings → Privacy &amp; Security → Camera allows the browser itself.';
  }
  return base;
}
