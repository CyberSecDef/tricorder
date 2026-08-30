/**
 * Microphone acquisition, per-profile (§5).
 *
 * The voice DSP chain is helpful for voice and catastrophic for measurement,
 * and different instruments need incompatible constraints — so there is
 * deliberately NO shared global mic stream. Each screen acquires the profile
 * it needs and releases it on exit. A leaked stream keeps the orange privacy
 * indicator lit, which users reasonably read as the app spying on them.
 */

import { getAudioContext } from '../lib/permissions';

export type MicProfile = 'default' | 'raw';

const PROFILES: Record<MicProfile, MediaTrackConstraints> = {
  // Voice-style defaults. Fine for anything that only asks "is there sound".
  default: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  // Measurement path: nothing between the microphone and the FFT.
  //  - AGC rescales amplitude between frames, so the display lies.
  //  - NS carves holes in the noise floor and deletes steady ultrasonic tones.
  //  - AEC exists to cancel sound the device just emitted — i.e. our own chirp.
  raw: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
};

export interface MicHandle {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  ctx: AudioContext;
  /** The constraints the browser actually applied — not what we asked for. */
  settings: MediaTrackSettings;
  release(): void;
}

export class AudioUnavailableError extends Error {
  constructor(public readonly reason: 'no-context' | 'no-api' | 'denied' | 'failed', message: string) {
    super(message);
    this.name = 'AudioUnavailableError';
  }
}

export async function acquireMic(profile: MicProfile = 'raw'): Promise<MicHandle> {
  const ctx = getAudioContext();
  if (!ctx) {
    throw new AudioUnavailableError('no-context', 'AudioContext not started — run the boot gate first.');
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new AudioUnavailableError('no-api', 'getUserMedia unavailable. Is this a secure context?');
  }

  // iOS suspends the context when the tab is backgrounded.
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* reported via ctx.state below */ }
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: PROFILES[profile], video: false });
  } catch (e) {
    const err = e as DOMException;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    throw new AudioUnavailableError(
      denied ? 'denied' : 'failed',
      denied ? 'Microphone permission denied.' : `Microphone unavailable: ${err?.name ?? e}`,
    );
  }

  const track = stream.getAudioTracks()[0];
  const settings = track?.getSettings?.() ?? {};
  const source = ctx.createMediaStreamSource(stream);

  let released = false;
  return {
    stream,
    source,
    ctx,
    settings,
    release() {
      if (released) return;
      released = true;
      try { source.disconnect(); } catch { /* already disconnected */ }
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/** Whether the applied settings actually match the profile we asked for. */
export function profileApplied(settings: MediaTrackSettings, profile: MicProfile): boolean {
  const want = PROFILES[profile];
  const keys = ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const;
  return keys.every((k) => {
    const applied = (settings as any)[k];
    // Undefined means the browser does not report it — we cannot verify, so
    // we do not claim a mismatch.
    return applied === undefined || applied === (want as any)[k];
  });
}

export const profileConstraints = (p: MicProfile): MediaTrackConstraints => ({ ...PROFILES[p] });
