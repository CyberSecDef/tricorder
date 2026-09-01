/**
 * Sonar capture worklet.
 *
 * Plain JS, loaded with `?url` — AudioWorklet code runs in its own global
 * scope and is not part of the bundle graph, so it is deliberately not
 * TypeScript.
 *
 * Its only job is to hand the main thread microphone samples STAMPED WITH
 * THEIR ABSOLUTE FRAME INDEX. That stamp is the measurement: range is derived
 * from the delay between the frame a chirp was scheduled at and the frame its
 * echo arrives in, and one sample of timing error is 3.6 mm of range error.
 * `currentFrame` in the worklet scope shares a timebase with
 * `audioContext.currentTime * sampleRate`, which is what makes the comparison
 * legitimate.
 *
 * §8.10 requires AudioWorklet rather than ScriptProcessorNode: the latter is
 * deprecated and glitches, and a dropped block here is not a cosmetic problem
 * but a wrong distance.
 */

/** 8 render quanta. A multiple of 128, so no quantum is ever split. */
const CHUNK = 1024;

class SonarCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(CHUNK);
    this.fill = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;

    // Stamp when the chunk opens. Because CHUNK is a whole number of quanta
    // and quanta are never split, this frame index is exact rather than
    // interpolated.
    if (this.fill === 0) this.startFrame = currentFrame;

    this.chunk.set(ch, this.fill);
    this.fill += ch.length;

    if (this.fill >= CHUNK) {
      // Transfer rather than copy: this runs on the audio thread and must not
      // spend time it does not have.
      const out = this.chunk;
      this.port.postMessage({ startFrame: this.startFrame, samples: out }, [out.buffer]);
      this.chunk = new Float32Array(CHUNK);
      this.fill = 0;
    }
    return true;
  }
}

registerProcessor('sonar-capture', SonarCaptureProcessor);
