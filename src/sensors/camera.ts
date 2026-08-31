/**
 * Camera acquisition (§7). Acquired by the screen that needs it and released
 * on exit — a leaked track keeps the iOS privacy indicator lit.
 *
 * The <video> element MUST carry `playsinline` and `muted` or iOS refuses to
 * play it inline and you get a black rectangle with no error.
 */

export interface CameraHandle {
  stream: MediaStream;
  video: HTMLVideoElement;
  track: MediaStreamTrack;
  settings: MediaTrackSettings;
  /** Torch is not reliably available on iOS — null when the track has none. */
  torch: ((on: boolean) => Promise<void>) | null;
  release(): void;
}

export class CameraUnavailableError extends Error {
  constructor(public readonly reason: 'no-api' | 'denied' | 'failed', message: string) {
    super(message);
    this.name = 'CameraUnavailableError';
  }
}

export async function acquireCamera(): Promise<CameraHandle> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new CameraUnavailableError('no-api', 'getUserMedia unavailable. Is this a secure context?');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
  } catch (e) {
    const err = e as DOMException;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    throw new CameraUnavailableError(
      denied ? 'denied' : 'failed',
      denied ? 'Camera permission denied.' : `Camera unavailable: ${err?.name ?? e}`,
    );
  }

  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  // Both attributes are required on iOS. Without them playback is refused.
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.playsInline = true;
  video.muted = true;
  video.autoplay = true;
  video.srcObject = stream;

  await new Promise<void>((resolve) => {
    if (video.readyState >= 2) return resolve();
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
    // Do not hang forever if metadata never arrives.
    setTimeout(resolve, 4000);
  });
  try { await video.play(); } catch { /* autoplay policy; the element still shows frames */ }

  // Torch: feature-detect and hide any UI that depends on it (§7). Never
  // build an instrument that requires it.
  let torch: CameraHandle['torch'] = null;
  const caps = (track as any).getCapabilities?.();
  if (caps && 'torch' in caps && caps.torch) {
    torch = async (on: boolean) => {
      await (track as any).applyConstraints({ advanced: [{ torch: on }] });
    };
  }

  let released = false;
  return {
    stream,
    video,
    track,
    settings: track?.getSettings?.() ?? {},
    torch,
    release() {
      if (released) return;
      released = true;
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
      for (const t of stream.getTracks()) t.stop();
    },
  };
}

/**
 * Map a tap on the video element to normalised frame coordinates.
 *
 * The element is almost never the same shape as the frame, so CSS object-fit
 * scales and crops. Ignoring that is the classic bug in this instrument (§8.6
 * step 3): taps land at the wrong angle and every distance is quietly wrong.
 *
 * Returns u,v in [-1,1] with v POSITIVE UPWARD, or null when the tap lands on
 * letterboxing outside the frame (possible with `contain`).
 */
export function tapToFrameCoords(
  clientX: number,
  clientY: number,
  el: HTMLElement,
  frameW: number,
  frameH: number,
  fit: 'cover' | 'contain' = 'cover',
): { u: number; v: number } | null {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height || !frameW || !frameH) return null;

  // `cover` scales up until both axes are filled and crops the overflow;
  // `contain` scales down until both fit and letterboxes the remainder.
  const scale = fit === 'cover'
    ? Math.max(r.width / frameW, r.height / frameH)
    : Math.min(r.width / frameW, r.height / frameH);

  const shownW = frameW * scale;
  const shownH = frameH * scale;
  const offX = (r.width - shownW) / 2;
  const offY = (r.height - shownH) / 2;

  const fx = (clientX - r.left - offX) / scale;   // pixels into the frame
  const fy = (clientY - r.top - offY) / scale;

  if (fx < 0 || fy < 0 || fx > frameW || fy > frameH) return null;

  return {
    u: (fx / frameW) * 2 - 1,
    v: 1 - (fy / frameH) * 2,   // screen y grows downward; v grows upward
  };
}
