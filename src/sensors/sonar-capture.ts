/**
 * Main-thread side of the sonar capture: a ring buffer indexed by ABSOLUTE
 * audio frame.
 *
 * Everything here exists so that "give me the 4096 samples starting at frame
 * F" is answerable, where F comes from the time a chirp was scheduled. Ordinary
 * ring buffers index by position; this one indexes by the audio clock, because
 * the audio clock is what the measurement is made against.
 */

import workletUrl from './sonar-worklet.js?url';

export class SonarCapture {
  private ring: Float32Array;
  private node: AudioWorkletNode | null = null;
  /** Absolute frame index one past the last sample written. */
  private endFrame = 0;
  private started = false;

  constructor(private readonly ctx: AudioContext, seconds = 2) {
    this.ring = new Float32Array(Math.ceil(ctx.sampleRate * seconds));
  }

  async start(source: AudioNode): Promise<void> {
    if (this.started) return;
    await this.ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(this.ctx, 'sonar-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (e) => this.onChunk(e.data);
    source.connect(node);

    // §0.7 — WebKit only pulls a graph that reaches the destination. A worklet
    // hanging off the microphone with nothing downstream is never called, and
    // it fails silently: no error, just no samples ever.
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    node.connect(sink);
    sink.connect(this.ctx.destination);

    this.node = node;
    this.sink = sink;
    this.started = true;
  }

  private sink: GainNode | null = null;

  private onChunk(msg: { startFrame: number; samples: Float32Array }): void {
    const { startFrame, samples } = msg;
    const size = this.ring.length;
    // A gap means the audio thread dropped blocks; keep the clock honest
    // rather than silently shifting every subsequent sample.
    for (let i = 0; i < samples.length; i++) {
      this.ring[(startFrame + i) % size] = samples[i];
    }
    this.endFrame = Math.max(this.endFrame, startFrame + samples.length);
  }

  /** Newest frame index captured so far. */
  get available(): number { return this.endFrame; }

  /**
   * Samples [startFrame, startFrame+length), or null if that span has not
   * arrived yet or has already been overwritten.
   */
  read(startFrame: number, length: number, into?: Float32Array): Float32Array | null {
    const size = this.ring.length;
    if (startFrame < 0) return null;
    if (startFrame + length > this.endFrame) return null;          // not yet captured
    if (startFrame < this.endFrame - size) return null;            // already overwritten
    const out = into && into.length === length ? into : new Float32Array(length);
    for (let i = 0; i < length; i++) out[i] = this.ring[(startFrame + i) % size];
    return out;
  }

  stop(): void {
    if (this.node) { this.node.port.onmessage = null; try { this.node.disconnect(); } catch { /* gone */ } }
    if (this.sink) { try { this.sink.disconnect(); } catch { /* gone */ } }
    this.node = null;
    this.sink = null;
    this.started = false;
  }
}
