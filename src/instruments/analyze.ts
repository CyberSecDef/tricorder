/**
 * Analyze (§20) — "what is this?" from a photograph, entirely on-device.
 *
 * THIS INSTRUMENT DOES NOT MEASURE ANYTHING, and that is the whole design
 * problem. Every other screen in this app reports a quantity a sensor actually
 * produced, and the §9 rule is that anything derived or uncalibrated says so on
 * its face. A vision-language model does not produce a quantity at all. It
 * produces fluent, plausible English that is sometimes wrong, with no error bar
 * available even in principle — there is no σ to report, because the failure
 * mode is not noise, it is confabulation.
 *
 * So it is deliberately framed unlike anything else here: no `readout` for the
 * answer, no state dot, no units. The model's own name sits above its output
 * and the output is labelled a guess. The one honest number available — how
 * long inference took — is reported as a readout, because that IS measured.
 *
 * On-device was chosen over the Gemini and Cloud Vision alternatives, both of
 * which were verified to accept direct browser calls. The reasons were that a
 * static host has nowhere to hide an API key, and that sending camera frames of
 * whatever you are pointing at to a third party is a change to what this app
 * is. Nothing here leaves the phone.
 *
 * MEASURED, on a headless SwiftShader adapter with no GPU and no shader-f16:
 * 658 s for one 80-token answer, which is only evidence that the code path
 * works. Real hardware is a different machine entirely — Depth went 3000 ms to
 * 500 ms on the same transition. The first honest timing comes from a phone.
 */

import { Instrument } from '../ui/screen';
import { el, append, readout, fmt, section, notice, escapeHtml, clear } from '../ui/dom';
import { acquireCamera, CameraUnavailableError, type CameraHandle } from '../sensors/camera';

const MODEL = 'HuggingFaceTB/SmolVLM-256M-Instruct';

/**
 * Longest edge of the frame handed to the processor.
 *
 * NOTE that on its own this number does nothing, and believing otherwise cost
 * a crash on a real phone. Idefics3's processor ships `size.longest_edge:
 * 2048` and `do_image_splitting: true`, so a 512 px capture was being resized
 * UP to 2048 and then cut into a 4x4 grid — sixteen 512px tiles plus a global
 * thumbnail, seventeen vision-encoder passes and roughly 1100 image tokens,
 * from one photograph. iOS killed the tab.
 *
 * This is the same trap as §8.9's depth-processor bug ("handing the pipeline a
 * smaller canvas is WRONG"), met from the other side: there the processor
 * resized up to the model's native size, here it resizes up and then tiles.
 * The lesson generalises — with Transformers.js, the processor's own config is
 * the thing that decides cost, and the canvas you hand it is nearly
 * irrelevant. `applyProcessorLimits()` is what actually makes this number mean
 * something.
 */
const CAPTURE_PX = 512;

/** One tile, no splitting. See applyProcessorLimits(). */
const TILE_PX = 512;
const MAX_NEW_TOKENS = 72;

const PROMPTS = [
  { id: 'what',   label: 'What is this?',  text: 'What is in this image? Answer in one or two sentences.' },
  { id: 'detail', label: 'Describe it',    text: 'Describe this image in detail.' },
  { id: 'text',   label: 'Read any text',  text: 'What text appears in this image? If there is none, say so.' },
  { id: 'count',  label: 'Count objects',  text: 'How many distinct objects are in this image, and what are they?' },
] as const;

type PromptId = typeof PROMPTS[number]['id'];

interface Backend {
  device: 'webgpu' | 'wasm';
  f16: boolean;
  adapter: string;
}

/**
 * WebGPU exposing an adapter does NOT imply that adapter can do fp16.
 * `shader-f16` is an optional per-adapter feature, and asking for an fp16 or
 * q4f16 weight file without it fails at session creation with "The device
 * (webgpu) does not support fp16" — after the download. This is the same shape
 * as the §8.9 trap where `'gpu' in navigator` was treated as a capability test.
 */
async function probeBackend(): Promise<Backend> {
  const gpu = (navigator as any).gpu;
  if (!gpu) return { device: 'wasm', f16: false, adapter: 'none — WebGPU absent' };
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { device: 'wasm', f16: false, adapter: 'none — no adapter granted' };
    const info = await adapter.requestAdapterInfo?.().catch(() => null) ?? adapter.info ?? null;
    const name = [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'unnamed adapter';
    return { device: 'webgpu', f16: !!adapter.features?.has('shader-f16'), adapter: name };
  } catch {
    return { device: 'wasm', f16: false, adapter: 'none — adapter request threw' };
  }
}

export class AnalyzeInstrument extends Instrument {
  readonly id = 'analyze';
  readonly title = 'Analyze';
  override readonly subtitle = 'On-device vision model';
  override readonly resources = 'camera';

  private cam: CameraHandle | null = null;
  private model: any = null;
  private processor: any = null;
  private backend: Backend | null = null;
  private busy = false;
  private prompt: PromptId = 'what';
  private frame: HTMLCanvasElement | null = null;
  private split = false;

  protected build(root: HTMLElement): void {
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    const statusBox = el('div');
    append(scroll, statusBox);

    append(scroll, notice('warn',
      '<strong>This instrument does not measure anything.</strong> Everything else in this app reports a ' +
      'quantity a sensor produced. This runs a small language model over a photograph and prints what it ' +
      'says — fluent, frequently right, and <em>confidently wrong</em> some of the time, with no error bar ' +
      'possible. Treat it as a suggestion, never as a reading. Nothing leaves the phone: the model runs here.'));

    void this.start(scroll, statusBox);
  }

  private async start(scroll: HTMLElement, statusBox: HTMLElement): Promise<void> {
    this.backend = await probeBackend();
    if (!this.isMounted) return;

    try {
      this.cam = await acquireCamera();
    } catch (e) {
      append(statusBox, notice('bad', `<strong>Camera unavailable.</strong> ${escapeHtml((e as CameraUnavailableError).message)}`));
      return;
    }
    if (!this.isMounted) { this.cam.release(); return; }
    this.onCleanup(() => { this.teardown(); this.cam?.release(); });

    // --- Viewfinder ------------------------------------------------------
    const view = el('div', { class: 'analyze__view' });
    const video = this.cam.video;
    video.setAttribute('playsinline', '');
    video.className = 'analyze__video';
    append(view, video);
    append(scroll, section('View'), view);

    // --- Model ------------------------------------------------------------
    const b = this.backend;
    const size = b.f16 ? '~190 MB' : '~265 MB';
    const btnLoad = el('button', { class: 'btn', type: 'button' }, `Load model (${size})`);
    const barWrap = el('div', { class: 'bar-track' });
    const bar = el('div', { class: 'bar-fill' });
    append(barWrap, bar);
    const progLabel = el('div', { class: 'dim', style: 'font-size:11px' });
    const modelBox = el('div');

    append(scroll, section('Model'),
      notice(b.device === 'webgpu' ? (b.f16 ? 'ok' : 'warn') : 'warn',
        `<strong>${escapeHtml(MODEL)}</strong> — 256M parameters, downloaded once and cached by the browser. ` +
        `Backend: <code>${escapeHtml(b.device)}</code> on ${escapeHtml(b.adapter)}. ` +
        (b.device !== 'webgpu'
          ? 'Without WebGPU this runs on WASM and will be <strong>very</strong> slow — minutes, not seconds.'
          : b.f16
            ? 'This adapter supports <code>shader-f16</code>, so the smaller half-precision weights are used.'
            : 'This adapter reports <strong>no <code>shader-f16</code></strong>, so the larger 4-bit integer ' +
              'weights are used instead. Note that a software adapter (SwiftShader) will still take minutes ' +
              'per answer — WebGPU being present is not the same as a GPU being present.')),
      el('div', { class: 'btn-row' }, btnLoad), barWrap, progLabel, modelBox);

    btnLoad.addEventListener('click', () => void this.load(btnLoad, bar, progLabel, modelBox));

    // --- Question ---------------------------------------------------------
    const promptRow = el('div', { class: 'btn-row' });
    const promptBtns = new Map<PromptId, HTMLElement>();
    for (const p of PROMPTS) {
      const btn = el('button', { class: 'btn btn--alt', type: 'button', 'aria-pressed': String(p.id === this.prompt) }, p.label);
      btn.addEventListener('click', () => {
        this.prompt = p.id;
        for (const [id, x] of promptBtns) x.setAttribute('aria-pressed', String(id === this.prompt));
      });
      promptBtns.set(p.id, btn);
      append(promptRow, btn);
    }

    const btnRun = el('button', { class: 'btn', type: 'button', disabled: 'true' }, 'Load the model first');
    const rTime = readout('Inference', { unit: 's', note: 'wall clock, this device' });
    const rTok = readout('Answer length', { unit: 'tokens', note: '' });
    const rCost = readout('Prompt size', { unit: 'tokens', note: 'image + question' });
    this.costReadout = rCost;
    const answerBox = el('div');

    btnRun.addEventListener('click', () => void this.run(btnRun, answerBox, rTime, rTok));
    this.runBtn = btnRun;

    append(scroll, section('Question'), promptRow,
      el('div', { class: 'btn-row' }, btnRun),
      el('div', { class: 'grid' }, rTime.node, rTok.node, rCost.node),
      answerBox);

    append(scroll, section('Why this is not a readout'), notice('warn',
      'A number from the seismograph can be wrong by a stated amount. This cannot: when a vision-language ' +
      'model is wrong it is not off by 10%, it has described a different object entirely, in the same ' +
      'confident register it uses when correct. There is no confidence score to show you, so none is shown. ' +
      'The only measured quantity on this screen is how long the inference took.'));
  }

  private runBtn: HTMLElement | null = null;
  private costReadout: any = null;

  private async load(btn: HTMLElement, bar: HTMLElement, label: HTMLElement, box: HTMLElement): Promise<void> {
    if (this.model || this.busy) return;
    this.busy = true;
    (btn as HTMLButtonElement).disabled = true;
    btn.textContent = 'Loading…';
    clear(box);

    try {
      // Dynamic import: the other instruments must not pay for this chunk.
      const { AutoProcessor, AutoModelForVision2Seq, env } = await import('@huggingface/transformers');
      const wasmEnv = (env as any).backends?.onnx?.wasm;
      if (wasmEnv) wasmEnv.wasmPaths = `${import.meta.env.BASE_URL}ort/`;

      const b = this.backend!;
      const dtype = b.f16
        ? { embed_tokens: 'fp16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' }
        : { embed_tokens: 'q8',   vision_encoder: 'q4',    decoder_model_merged: 'q4' };

      const files = new Map<string, number>();
      const progress_callback = (p: any) => {
        if (p.status === 'progress' && typeof p.progress === 'number') {
          files.set(p.file, p.progress);
          const pct = [...files.values()].reduce((a, x) => a + x, 0) / files.size;
          bar.style.width = `${pct.toFixed(1)}%`;
          label.textContent = `${pct.toFixed(0)}% · ${p.file ?? ''}`;
        } else if (p.status === 'ready') {
          bar.style.width = '100%';
          label.textContent = 'ready';
        }
      };

      this.processor = await AutoProcessor.from_pretrained(MODEL, { progress_callback } as any);
      this.applyProcessorLimits();
      this.model = await AutoModelForVision2Seq.from_pretrained(MODEL, {
        device: b.device, dtype, progress_callback,
      } as any);

      if (!this.isMounted) { this.teardown(); return; }
      btn.textContent = 'Model loaded';
      if (this.runBtn) {
        (this.runBtn as HTMLButtonElement).disabled = false;
        this.runBtn.textContent = 'Capture and analyze';
      }
    } catch (e) {
      append(box, notice('bad', `<strong>Could not load the model.</strong> ${escapeHtml(String((e as Error)?.message ?? e))}`));
      (btn as HTMLButtonElement).disabled = false;
      btn.textContent = 'Retry load';
    } finally {
      this.busy = false;
    }
  }

  /**
   * Clamp the image processor so one photograph is one tile.
   *
   * Set on the processor AND passed per call, because Transformers.js reads
   * `do_image_splitting` from the options merged at call time
   * (`e.do_image_splitting ?? true`) — mutating the config alone is not
   * reliably enough, and neither is the per-call flag if a later version
   * re-reads config. Belt and braces on the one setting that decides whether
   * this instrument runs or kills the tab.
   */
  private applyProcessorLimits(): void {
    const ip = (this.processor as any)?.image_processor;
    if (!ip) return;
    const size = { longest_edge: TILE_PX };
    ip.do_image_splitting = this.split;
    ip.size = size;
    ip.max_image_size = { longest_edge: TILE_PX };
    if (ip.config) {
      ip.config.do_image_splitting = this.split;
      ip.config.size = size;
      ip.config.max_image_size = { longest_edge: TILE_PX };
    }
  }

  /** Grab the current frame at CAPTURE_PX on the longest edge. */
  private capture(): HTMLCanvasElement | null {
    const v = this.cam?.video;
    if (!v || !v.videoWidth) return null;
    const scale = CAPTURE_PX / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    const c = this.frame ?? document.createElement('canvas');
    this.frame = c;
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(v, 0, 0, w, h);
    return c;
  }

  private async run(btn: HTMLElement, box: HTMLElement, rTime: any, rTok: any): Promise<void> {
    if (!this.model || this.busy) return;
    const canvas = this.capture();
    if (!canvas) {
      clear(box);
      append(box, notice('bad', '<strong>No frame.</strong> The camera has not produced a picture yet.'));
      return;
    }

    this.busy = true;
    (btn as HTMLButtonElement).disabled = true;
    btn.textContent = 'Thinking…';
    clear(box);
    rTime.set('—', 'running');
    rTime.setState('warn');

    // Pause the video during inference. Its decode buffers are live memory on
    // a device that is already at its ceiling, and nothing needs a moving
    // picture while the model runs on a frame already captured.
    const vid = this.cam?.video;
    try { vid?.pause(); } catch { /* not fatal */ }

    const t0 = performance.now();
    try {
      const { RawImage } = await import('@huggingface/transformers');
      const image = await RawImage.fromCanvas(canvas);
      const question = PROMPTS.find((p) => p.id === this.prompt)!;

      const messages = [{ role: 'user', content: [{ type: 'image' }, { type: 'text', text: question.text }] }];
      const text = this.processor.apply_chat_template(messages, { add_generation_prompt: true });
      this.applyProcessorLimits();
      const inputs = await this.processor(text, [image], {
        do_image_splitting: this.split,
        size: { longest_edge: TILE_PX },
      });
      const ids = await this.model.generate({ ...inputs, max_new_tokens: MAX_NEW_TOKENS, do_sample: false });

      const full = this.processor.batch_decode(ids, { skip_special_tokens: true })[0] as string;
      const answer = full.split('Assistant:').pop()!.trim();
      const secs = (performance.now() - t0) / 1000;

      if (!this.isMounted) return;
      rTime.set(fmt(secs, 1), `${this.backend?.device} · ${this.backend?.f16 ? 'q4f16' : 'q4'}`);
      rTime.setState(secs < 10 ? 'ok' : 'warn');
      const promptTok = Number(inputs?.input_ids?.dims?.at?.(-1) ?? 0);
      // The number that decides whether this runs or crashes. With splitting
      // on it was ~1100 for a single photo; one tile is roughly a tenth of it.
      this.costReadout?.set(promptTok ? String(promptTok) : '—',
        this.split ? 'image split into tiles' : 'single tile');
      this.costReadout?.setState(promptTok > 900 ? 'bad' : promptTok > 400 ? 'warn' : 'ok');
      const nTok = Number(ids?.dims?.at?.(-1) ?? 0) - promptTok;
      rTok.set(nTok > 0 ? String(nTok) : '—', nTok >= MAX_NEW_TOKENS ? `capped at ${MAX_NEW_TOKENS}` : 'model stopped on its own');
      rTok.setState(nTok >= MAX_NEW_TOKENS ? 'warn' : 'ok');

      // A thumbnail of exactly the frame that was analysed, so the answer is
      // attached to a picture rather than floating free of what was in view.
      const thumb = el('canvas', { class: 'analyze__thumb' }) as HTMLCanvasElement;
      thumb.width = canvas.width; thumb.height = canvas.height;
      thumb.getContext('2d')!.drawImage(canvas, 0, 0);

      append(box,
        el('div', { class: 'analyze__head' },
          el('span', { class: 'analyze__tag', text: 'NOT A MEASUREMENT' }),
          el('span', { class: 'analyze__model', text: MODEL })),
        el('div', { class: 'analyze__row' }, thumb,
          el('div', { class: 'analyze__answer' },
            el('div', { class: 'analyze__q', text: question.text }),
            el('div', { class: 'analyze__a', text: answer || '(the model returned nothing)' }))));
    } catch (e) {
      append(box, notice('bad', `<strong>Inference failed.</strong> ${escapeHtml(String((e as Error)?.message ?? e))}`));
      rTime.set('—', 'failed');
      rTime.setState('bad');
    } finally {
      this.busy = false;
      try { if (this.isMounted) await vid?.play(); } catch { /* not fatal */ }
      if (this.isMounted) {
        (btn as HTMLButtonElement).disabled = false;
        btn.textContent = 'Capture and analyze';
      }
    }
  }

  /** Drop the model and its GPU session so leaving the screen frees the VRAM. */
  private teardown(): void {
    try { this.model?.dispose?.(); } catch { /* nothing useful to do */ }
    this.model = null;
    this.processor = null;
    this.frame = null;
  }
}
