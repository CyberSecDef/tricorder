/**
 * The single-gesture unlock (§4). This is the highest-risk piece of the app.
 *
 * iOS requires requestPermission() to be reached from inside a user gesture,
 * and Web Audio requires a gesture to start the AudioContext. So everything
 * that needs a gesture happens here, behind one ENGAGE button — and nothing
 * else does. Camera and mic are deliberately NOT requested here: they are
 * acquired by the screen that needs them, when it activates.
 */

import { capabilities } from './capabilities';

export type PermissionState = 'granted' | 'denied' | 'unavailable' | 'error';

export interface UnlockResult {
  motion: PermissionState;
  orientation: PermissionState;
  audio: PermissionState;
  audioSampleRate: number | null;
  errors: string[];
}

let audioCtx: AudioContext | null = null;
let unlocked: UnlockResult | null = null;

/** The shared AudioContext, created during the unlock gesture. */
export function getAudioContext(): AudioContext | null { return audioCtx; }
export function unlockResult(): UnlockResult | null { return unlocked; }
export const isUnlocked = (): boolean => unlocked !== null;

/**
 * MUST be called synchronously from a user gesture handler. Awaiting before
 * the first requestPermission() call loses the gesture and iOS rejects it.
 */
export async function unlock(): Promise<UnlockResult> {
  const caps = capabilities();
  const errors: string[] = [];

  const DME = DeviceMotionEvent as any;
  const DOE = DeviceOrientationEvent as any;

  // Two separate calls — granting one does not grant the other.
  let motion: PermissionState = 'granted';
  if (caps.motionGate) {
    try {
      motion = (await DME.requestPermission()) as PermissionState;
    } catch (e) {
      motion = 'error';
      errors.push(`motion: ${describe(e)}`);
    }
  } else if (!caps.deviceMotion) {
    motion = 'unavailable';
  } // else: pre-iOS-13 WebKit, or a non-gated engine — no prompt, already usable.

  let orientation: PermissionState = 'granted';
  if (caps.orientGate) {
    try {
      orientation = (await DOE.requestPermission()) as PermissionState;
    } catch (e) {
      orientation = 'error';
      errors.push(`orientation: ${describe(e)}`);
    }
  } else if (!caps.deviceOrientation) {
    orientation = 'unavailable';
  }

  // AudioContext must be constructed and resumed inside the gesture.
  let audio: PermissionState = 'unavailable';
  let audioSampleRate: number | null = null;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (Ctor) {
    try {
      audioCtx ??= new Ctor();
      if (audioCtx!.state === 'suspended') await audioCtx!.resume();
      audio = audioCtx!.state === 'running' ? 'granted' : 'error';
      // Never hardcode this — all bin math depends on it (§7).
      audioSampleRate = audioCtx!.sampleRate;
    } catch (e) {
      audio = 'error';
      errors.push(`audio: ${describe(e)}`);
    }
  }

  unlocked = { motion, orientation, audio, audioSampleRate, errors };
  return unlocked;
}

/** Resume a context iOS suspended while the tab was backgrounded. */
export async function resumeAudio(): Promise<void> {
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch { /* nothing useful to do */ }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * Recovery copy for a denial. There is no API to re-prompt once denied — the
 * user must clear website data, and the path differs per browser (§4). We
 * cannot detect which browser they are in without UA sniffing, so we show all
 * three and let them pick.
 */
export const DENIAL_HELP = [
  {
    browser: 'Safari',
    steps: 'Settings → Safari → Clear History and Website Data (or Advanced → Website Data → remove this site), then reload.',
  },
  {
    browser: 'Chrome / Edge',
    steps: 'In-app Settings → Privacy → Clear Browsing Data → Cookies & Site Data, then reload.',
  },
  {
    browser: 'All browsers on iOS',
    steps:
      'Check Settings → Safari → Motion & Orientation Access is ON. This one WebKit toggle governs Chrome and Edge too — they will fail with no visible cause if it is off, and you would never think to look under "Safari".',
  },
] as const;
