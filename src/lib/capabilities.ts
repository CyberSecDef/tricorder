/**
 * Feature detection. Never branch on the user-agent string (§1) — Chrome and
 * Edge on iOS both report Safari-like UA fragments, so sniffing gives wrong
 * answers. Every one of these is a capability probe.
 */

export interface Capabilities {
  secureContext: boolean;
  motionGate: boolean;      // DeviceMotionEvent.requestPermission exists (iOS 13+)
  orientGate: boolean;
  deviceMotion: boolean;
  deviceOrientation: boolean;
  compass: boolean;         // webkitCompassHeading — WebKit only
  geolocation: boolean;
  mediaDevices: boolean;
  webAudio: boolean;
  audioWorklet: boolean;
  wakeLock: boolean;
  webgpu: boolean;
  vibrate: boolean;         // absent on iOS in every browser (§9)
  standalone: boolean;      // installed PWA context — Safari only on iOS
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
}

export function detect(): Capabilities {
  const DME = typeof DeviceMotionEvent !== 'undefined' ? DeviceMotionEvent : undefined;
  const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : undefined;

  return {
    secureContext: window.isSecureContext === true,
    motionGate: typeof (DME as any)?.requestPermission === 'function',
    orientGate: typeof (DOE as any)?.requestPermission === 'function',
    deviceMotion: DME !== undefined,
    deviceOrientation: DOE !== undefined,
    compass: DOE ? 'webkitCompassHeading' in DOE.prototype : false,
    geolocation: 'geolocation' in navigator,
    mediaDevices: typeof navigator.mediaDevices?.getUserMedia === 'function',
    webAudio: typeof (window.AudioContext ?? (window as any).webkitAudioContext) === 'function',
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    wakeLock: 'wakeLock' in navigator,
    webgpu: 'gpu' in navigator,
    vibrate: typeof navigator.vibrate === 'function',
    standalone:
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: (window as any).crossOriginIsolated === true,
  };
}

/**
 * A stable-ish fingerprint of the capability set. Instrument 6's FOV
 * calibration is keyed by this rather than by UA, because Safari and
 * WKWebView may crop the camera stream differently (§8.6, §11.5).
 */
export function fingerprint(c: Capabilities): string {
  const bits: (keyof Capabilities)[] = [
    'motionGate', 'compass', 'wakeLock', 'webgpu', 'audioWorklet', 'standalone',
  ];
  return bits.map((k) => (c[k] ? '1' : '0')).join('');
}

let cached: Capabilities | null = null;
export function capabilities(): Capabilities {
  return (cached ??= detect());
}

/** Re-probe. `standalone` can change between a tab and a home-screen launch. */
export function refresh(): Capabilities {
  cached = detect();
  return cached;
}
