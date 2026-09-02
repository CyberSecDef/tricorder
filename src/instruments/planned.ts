/**
 * Placeholder screens for Instruments 6–10. They are in the rail from day one
 * deliberately: each one states what it will measure, what it cannot, and
 * which open question in §11 has to be answered before it can be built. The
 * build order in §2 is not arbitrary and skipping ahead is how this project
 * would go wrong.
 */

import { Instrument } from '../ui/screen';
import { el, append, section, notice } from '../ui/dom';

interface Plan {
  id: string;
  /** Rail label — kept short by hand; splitting the title gives poor results. */
  short: string;
  title: string;
  subtitle: string;
  milestone: string;
  difficulty: string;
  needs: string;
  principle: string;
  blockers: string[];
  honesty: string;
}

export const PLANNED: Plan[] = [
  {
    id: 'rangefinder',
    short: 'Range',
    title: 'Floor-Plane Rangefinder',
    subtitle: 'Metric distance from camera + gravity',
    milestone: 'M2',
    difficulty: 'Medium — the most useful instrument in the set',
    needs: 'Camera + DeviceMotion',
    principle:
      'With the camera at a known height h above a flat floor, a ray depressed θ below horizontal meets the floor at h / tan θ. Tap where an object meets the floor and the geometry gives a genuinely metric distance.',
    blockers: [
      'Gravity sign convention must be calibrated first (Core) — the whole derivation hangs on ĝ_down pointing the right way.',
      'FOV is the dominant error source and getUserMedia may crop relative to the native camera. Needs a calibration mode solving for FOV against a tape-measured distance, keyed by capability fingerprint rather than UA — Safari and WKWebView may crop differently (§11 q.5).',
      'Normalised tap coordinates must account for CSS object-fit cropping of the video element. This is the classic bug in this instrument.',
    ],
    honesty:
      'Error grows as 1/tan θ, so accuracy degrades sharply with distance. Good to a few percent from 0.5–5 m; refuses to display beyond ~8 m, and shows an uncertainty band.',
  },
  {
    id: 'magnetic',
    short: 'Magnetic',
    title: 'Magnetic Anomaly Detector',
    subtitle: 'Gyro/compass residual — relative index',
    milestone: 'M2',
    difficulty: 'Medium — the most surprising instrument in the set',
    needs: 'DeviceOrientation + DeviceMotion',
    principle:
      'The raw magnetometer is unreachable in every iOS browser, so we infer disturbance instead. Signal A: plot webkitCompassAccuracy over time — it degrades near ferrous mass. Signal B: the gyroscope is magnetically immune and the compass is not, so integrate yaw rate about true vertical and compare it against the actual compass heading change. The residual is the anomaly.',
    blockers: [
      'RESOLVED (§11 q.2), measured on iPhone / iOS 26.6.1 with the PROBE screen. Signal B is NOT damped. A phone resting on a table holds a residual noise floor of 0.021° RMS; a neodymium magnet brought to the top of it drives a 14.3° excursion. That is 691x the noise floor against a threshold of 4x. Signal A responded too, but weakly and late: webkitCompassAccuracy went 10° to 26°, clearing its 10° threshold but lagging the residual by seconds.',
      'Yaw rate must be projected onto the gravity vector, not read from rotationRate.alpha — alpha is only yaw when the phone lies flat on its back.',
      'MEASURED: the instrument must gate on compass calibration. At webkitCompassAccuracy of 89° the heading wanders 60° unprompted, which is a false anomaly larger than any real one. Refuse to report an index above ~20° accuracy and tell the user to run a figure-eight.',
      'MEASURED: the detrend EMA must reset per measurement session. A 25 s time constant carries charge across runs and inflated one baseline noise floor by 627x.',
      'Heading difference must be unwrapped across the 0/360 seam, and gyro bias detrended with a 20–30 s EMA.',
    ],
    honesty:
      'Labelled "relative index". No µT reading will be shown, because none can be obtained.',
  },
  {
    id: 'doppler',
    short: 'Doppler',
    title: 'Ultrasonic Doppler',
    subtitle: 'Motion detection via sideband energy',
    milestone: 'M3',
    difficulty: 'Medium',
    needs: 'Web Audio — raw mic profile mandatory',
    principle:
      'Emit a steady ~20 kHz tone and watch the bins either side of the carrier. Δf = 2vf/c, so 1 m/s of motion shifts about 117 Hz at 20 kHz — roughly 40 bins at fftSize 16384. Sideband asymmetry gives approach versus recede.',
    blockers: [
      'Carrier frequency depends on the runtime sample rate: 20 kHz at 48 kHz, ~18 kHz at 44.1 kHz. Check Core.',
      'Noise suppression treats a steady tone as noise and deletes the carrier outright; AGC destroys the amplitude the motion index is built on. The raw profile is not optional here.',
      'The hardware mute switch silences Web Audio output. Needs a "no signal at the emit frequency — check the mute switch" hint.',
    ],
    honesty:
      'Detects gross body movement at close range. It does NOT detect breathing or heartbeat — those shifts are sub-Hz and buried in carrier leakage. It will never be labelled a life-sign detector.',
  },
  {
    id: 'depth',
    short: 'Depth',
    title: 'ML Depth Scanner',
    subtitle: 'Monocular depth estimation',
    milestone: 'M4',
    difficulty: 'Hard — the best visual in the set',
    needs: 'Camera + ONNX via WebGPU, WASM fallback',
    principle:
      'Depth-Anything-V2-small through Transformers.js, downscaled to 256–384 px, inference decoupled from the render loop, false-coloured with a perceptually uniform ramp.',
    blockers: [
      'RESOLVED (§11 q.6): WebGPU is present in Chrome on iOS 26.6.1, so WKWebView exposes it and this is not Safari-only. Commit to the WebGPU path; keep the WASM fallback as a safety net rather than an expected route.',
      'Model download is 25–50 MB and the cache is per-browser, so trying the app in both Safari and Chrome downloads it twice. Needs a first-run progress bar.',
      'Per-frame min/max normalisation causes severe flicker — the normalisation bounds need an EMA across frames.',
    ],
    honesty:
      'The model outputs RELATIVE INVERSE DEPTH, not metres. Any metric scale would come from fitting against tapped floor points from the rangefinder, and would be labelled estimated.',
  },
  {
    id: 'sonar',
    short: 'Sonar',
    title: 'Acoustic Sonar',
    subtitle: 'Matched-filter time-of-flight',
    milestone: 'M5',
    difficulty: 'Hard — build last',
    needs: 'Web Audio AudioWorklet — raw mic profile mandatory',
    principle:
      'A Hann-windowed 15→22 kHz chirp over ~10 ms, captured through an AudioWorklet ring buffer and cross-correlated against the reference via FFT multiply. One sample at 48 kHz is 7.15 mm of path, so 3.6 mm of range resolution.',
    blockers: [
      'Echo cancellation exists precisely to cancel sound the device just emitted. It will cancel the chirp. Raw profile mandatory.',
      'The bottom speaker and bottom mic are centimetres apart, so direct coupling dominates. The first 1–2 ms of the correlation must be blanked before peak-picking.',
      'Chirp band depends on the runtime sample rate — 22 kHz needs 48 kHz sampling.',
    ],
    honesty:
      'Realistically 0.2–3 m against a large flat surface in a quiet room, and pointing-sensitive. Presented as an A-scope trace of correlation amplitude versus range rather than a single number — more honest, and more tricorder-like.',
  },
];

export class PlannedInstrument extends Instrument {
  readonly id: string;
  readonly title: string;
  override readonly subtitle: string;
  override readonly resources = 'none — not yet implemented';

  constructor(private readonly plan: Plan) {
    super();
    this.id = plan.id;
    this.title = plan.title;
    this.subtitle = plan.subtitle;
  }

  protected build(root: HTMLElement): void {
    const p = this.plan;
    const scroll = el('div', { class: 'stage__scroll' });
    append(root, scroll);

    append(
      scroll,
      notice('warn', `<strong>Not yet built.</strong> Scheduled for <strong>${p.milestone}</strong> · ${p.difficulty} · requires ${p.needs}.`),
      section('Principle'),
      el('div', { class: 'notice', style: 'border-left-color:var(--lc-bell);background:#0d1020' }, p.principle),
      section('Must be resolved first'),
      el('ul', { class: 'notice', style: 'border-left-color:var(--lc-rust);background:#180d0d' },
        ...p.blockers.map((b) => el('li', { text: b }))),
      section('What it will and will not claim'),
      el('div', { class: 'notice notice--ok' }, p.honesty),
    );
  }
}
