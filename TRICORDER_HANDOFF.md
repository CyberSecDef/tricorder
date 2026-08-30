# Web Tricorder — Implementation Handoff

**Target:** A browser-based "tricorder" sensor suite that runs on **iOS**, in **Safari, Chrome and Edge**.
**Status:** Greenfield. Nothing built yet.
**Prime constraint:** iOS only. Do not assume any Android/desktop-Chrome-only API.

---

## 0. Read this first — the six things that will waste your time

1. **On iOS, Chrome and Edge *are* Safari.** App Store rules require every iOS browser to render with WKWebView — Apple's WebKit. Chrome for iOS is not Blink; Edge for iOS is not Blink. Supporting all three does **not** widen the API surface by one function. It changes permissions, installability, and a few newer features. See §1.
2. **iOS has no WebXR, no Web Bluetooth, no Web NFC, no WebUSB, no Web Serial, no Battery Status API, and no Generic Sensor API** (`Accelerometer`, `Magnetometer`, `AmbientLightSensor`, `Gyroscope` classes all absent) — *in every browser on the platform.* Everything here uses `DeviceMotionEvent`, `DeviceOrientationEvent`, `getUserMedia`, Web Audio, and Geolocation. If you find yourself reaching for `new Magnetometer()`, stop.
3. **The raw magnetometer is not accessible.** Not behind a flag, not in any iOS browser. We detect *anomalies* via a gyro/compass residual instead (Instrument 7). Do not promise µT readings anywhere in the UI.
4. **iPhone LiDAR is not accessible from the web.** ARKit only. Depth comes from an ML model (Instrument 9).
5. **Motion sensors require an explicit permission call inside a real user gesture**, and the page must be served over **HTTPS** (a phone cannot use `localhost`). See §3 and §4.
6. **Audio DSP defaults will destroy the sonar and Doppler instruments** — but only those. Because this app is a set of screens, mic constraints are a *per-instrument* concern, not a global one. See §5.

---

## 1. Browser support on iOS

All three targets share one engine, so treat "does this work?" as a question about the **iOS version**, not the browser name. A device on iOS 18 running Chrome has the same WebKit as that device's Safari.

> **EU footnote:** iOS 17.4+ permits alternative browser engines in the EU via BrowserEngineKit. In practice neither Chrome nor Edge ships a non-WebKit iOS build. If that changes, this document's constraints get *looser*, never tighter — nothing here breaks.

### What is identical across Safari / Chrome / Edge on iOS

`DeviceMotionEvent`, `DeviceOrientationEvent` and their `requestPermission()` gate, `webkitCompassHeading` / `webkitCompassAccuracy`, Geolocation, Web Audio including AudioWorklet, `getUserMedia` for camera and mic (WKWebView has had these since iOS 14.3), Canvas/WebGL, and the absence of every API listed in §0.2.

### What actually differs

| Concern | Safari | Chrome / Edge on iOS | Consequence |
|---|---|---|---|
| **Add to Home Screen** (standalone PWA) | Yes | **No** — cannot install a standalone web app | The manifest and standalone permission context only matter for Safari. Chrome/Edge users run it as a tab. |
| Permission prompt UX | Native Safari sheet | WKWebView sheet, hosted by the app | Same API, different wording. Do not scrape prompt text. |
| Settings toggle for motion | Settings → Safari → Motion & Orientation Access | Same WebKit setting, but users will not think to look under "Safari" | Troubleshooting copy must say this explicitly. |
| Wake Lock | 16.4+ | Follows the same WebKit version — **verify on device** | Degrade silently if absent. |
| WebGPU (Instrument 9) | 26+, on by default | May lag or be disabled in WKWebView — **verify on device** | Fall back to the WASM backend. |
| URL bar / viewport chrome | Safari's | Differs, and resizes on scroll | Use `dvh` units and re-measure on `resize`; do not hardcode viewport height. |

**Practical rule:** build and test against Safari first because it is the strictest for installability, then verify the two open rows above on Chrome and Edge before shipping. Do not maintain browser-specific code paths — feature-detect.

### Feature detection, not browser sniffing

Never branch on the user-agent string. Chrome and Edge on iOS both report Safari-like UA fragments, and sniffing will produce wrong answers. Branch on the capability:

```js
const caps = {
  motionGate:  typeof DeviceMotionEvent?.requestPermission === 'function',
  orientGate:  typeof DeviceOrientationEvent?.requestPermission === 'function',
  compass:     'webkitCompassHeading' in DeviceOrientationEvent.prototype,
  wakeLock:    'wakeLock' in navigator,
  webgpu:      'gpu' in navigator,
  standalone:  window.matchMedia('(display-mode: standalone)').matches
                 || navigator.standalone === true,
};
```

Show the resulting capability list on a diagnostics screen. When an instrument is unavailable, say *why* — "WebGPU unavailable, falling back to WASM (slower)" beats a greyed-out panel.

---

## 2. Scope

Build a single-page PWA presenting a set of "instruments," each a self-contained **screen**. Aesthetic is up to you (LCARS-ish is the obvious call), but **signal correctness matters more than chrome** — every readout must come from a real measurement, and anything derived/uncalibrated must be labeled as such in the UI.

### Instruments, in recommended build order

| # | Instrument | Difficulty | Depends on |
|---|---|---|---|
| 1 | Permission/boot gate | — | — |
| 2 | Geo & navigation (GPS) | Easy | Geolocation |
| 3 | Compass / attitude | Easy | DeviceOrientation |
| 4 | Seismograph / vibration | Easy | DeviceMotion |
| 5 | Audio spectrum analyzer | Easy | Web Audio |
| 6 | Floor-plane rangefinder | Medium | Camera + DeviceMotion |
| 7 | Magnetic anomaly detector | Medium | DeviceOrientation + DeviceMotion |
| 8 | Ultrasonic Doppler motion | Medium | Web Audio |
| 9 | ML depth scanner | Hard | Camera + ONNX/WebGPU |
| 10 | Acoustic sonar rangefinder | Hard | Web Audio (AudioWorklet) |

Ship 1–5 as a working v1 before touching 6+.

### Explicit non-goals
- Absolute SPL in dB — we cannot calibrate a phone mic without a reference. Show dBFS or a relative scale.
- Richter magnitude — the accelerometer is not a seismometer. Show a relative/arbitrary index.
- Metric absolute depth from the ML model — it outputs *relative* inverse depth.
- Barometric pressure, temperature, humidity, radiation, NFC, battery — no API exists on iOS in any browser. Don't fake them.

---

## 3. Tech stack & structure

**Recommended:** Vite + TypeScript, vanilla DOM or a thin framework. Keep dependencies minimal — every extra MB hurts on a phone over a tunnel.

```
src/
  sensors/           # raw sensor streams, one module each; no UI
    motion.ts        # devicemotion -> {accel, accelG, rotationRate, interval}
    orientation.ts   # deviceorientation -> {alpha,beta,gamma,heading,headingAccuracy}
    geo.ts           # watchPosition wrapper
    audio.ts         # AudioContext + mic acquisition (per-profile) + AnalyserNode
    camera.ts        # getUserMedia video + frame grabber
  instruments/       # one screen per module; consumes sensors/, owns its own math
  lib/
    permissions.ts   # the single-gesture unlock (see §4)
    capabilities.ts  # feature detection (see §1)
    dsp.ts           # FFT helpers, correlation, filters
    vec.ts           # small 3-vector helpers
  ui/
```

### Screens own their resources

Because each instrument is a separate screen, the lifecycle is: **activate → acquire → run → release**. Motion and orientation are cheap, always-on, shared streams. Camera and mic are **acquired by the active screen and released on exit.**

Each sensor module exposes subscribe/unsubscribe and is safe for multiple consumers — several instruments read `devicemotion` simultaneously and you only want one listener. But the mic is different: see §5, different instruments need *incompatible* mic constraints, so `audio.ts` must acquire per-profile rather than hand out one shared stream.

---

## 4. Permissions & the boot gate (Instrument 1)

This is the highest-risk piece. Get it right first.

iOS requires `requestPermission()` for motion/orientation, called **synchronously from inside a user gesture handler**. Web Audio also requires a gesture to start the `AudioContext`. Do all of it behind one big **ENGAGE** button. This is identical in all three browsers.

```js
async function unlock() {
  const results = {};

  // Must be called from within the gesture handler. Both are separate calls.
  if (typeof DeviceMotionEvent?.requestPermission === 'function') {
    results.motion = await DeviceMotionEvent.requestPermission();
  } else {
    results.motion = 'granted'; // older iOS
  }
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    results.orientation = await DeviceOrientationEvent.requestPermission();
  } else {
    results.orientation = 'granted';
  }

  // AudioContext must be created/resumed in the gesture
  audioCtx = new AudioContext();
  await audioCtx.resume();

  // Keep the screen on (iOS 16.4+); absent in older WebKit
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}

  return results;
}
```

### Gotchas
- **Do not request camera or mic at boot.** They are requested by `getUserMedia` when the relevant *screen* first activates. Asking for all three up front looks alarming and invites a denial you cannot undo.
- Re-acquire the wake lock on `visibilitychange` — iOS drops it when you background the tab.
- If `requestPermission()` returns `'denied'`, recovery requires clearing website data for the site. Show a clear message; do not silently retry in a loop. **The recovery path differs per browser** — Safari: Settings → Safari → Clear History and Website Data (or per-site data). Chrome/Edge: their own in-app Settings → Privacy → Clear Browsing Data. Write all three into your troubleshooting copy.
- The **Settings → Safari → Motion & Orientation Access** toggle governs WebKit generally. A Chrome user with it off will see motion fail with no obvious cause, and will never think to look under "Safari." Call this out by name in the error state.
- **Standalone PWAs are a separate permission origin context, and only Safari can create one.** Motion permission granted in the Safari tab does not carry over to the home-screen app. Test both. Chrome/Edge users only ever have the tab context.

---

## 5. Audio constraints are per-instrument

The mic DSP chain (echo cancellation, noise suppression, automatic gain control) is helpful for voice and catastrophic for measurement — but **only for the instruments that measure**. Since each instrument is its own screen, request the mic with the profile that screen needs, and release it on exit.

```js
// lib/audio.ts
const PROFILES = {
  // Voice-style defaults. Fine for anything that only needs "is there sound."
  default:  { echoCancellation: true,  noiseSuppression: true,  autoGainControl: true  },
  // Measurement: raw signal path, nothing between the mic and the FFT.
  raw:      { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
};

export async function acquireMic(profile = 'raw') {
  return navigator.mediaDevices.getUserMedia({ audio: PROFILES[profile] });
}
```

| Instrument | Profile | Why |
|---|---|---|
| 5 — Spectrum analyzer | `raw` | AGC rescales amplitude between frames and NS carves holes in the noise floor. Both make the display lie. |
| 8 — Ultrasonic Doppler | `raw` — **mandatory** | NS treats a steady 20 kHz tone as noise and removes it. AGC destroys the amplitude measurement the motion index is built on. |
| 10 — Acoustic sonar | `raw` — **mandatory** | AEC exists specifically to cancel sound the device just emitted. It will cancel your chirp. |
| Any future voice/level meter | `default` | Voice DSP is doing its job here. |

**Do not hold one global mic stream for the whole app.** Two screens needing different profiles cannot share a stream, and a leaked stream keeps the orange privacy indicator lit — which users read as the app spying on them.

---

## 6. Serving it (you cannot skip this)

iOS requires a **secure context** for motion, geolocation, camera, and mic — in all three browsers. `http://<lan-ip>:5173` will silently fail: events just never fire, with no error. This misleads people for hours.

Pick one:
- **Best for iteration:** `vite --host` + a tunnel that terminates TLS — `cloudflared tunnel --url http://localhost:5173`, `ngrok http 5173`, or Tailscale Funnel.
- **Best for real use:** static deploy to Cloudflare Pages / Netlify / Vercel / GitHub Pages.
- **mkcert** with the CA installed and trusted on the iPhone works but is fiddly, and each browser trusts the profile differently. Only bother if offline.

### PWA manifest
Include `manifest.webmanifest` with `display: "standalone"`, an `apple-touch-icon`, and `<meta name="apple-mobile-web-app-capable" content="yes">`. **This only takes effect in Safari** — Chrome and Edge on iOS cannot install a standalone web app. Design the in-page chrome so the app is fully usable in a browser tab with a URL bar consuming vertical space, and use `dvh` rather than `vh` so the collapsing URL bar does not clip your instrument panels.

### If you use multithreaded WASM (Instrument 9 fallback path)
`SharedArrayBuffer` requires cross-origin isolation:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Note this breaks loading third-party resources without CORP headers. Prefer the WebGPU path and avoid this if you can.

---

## 7. Sensor reference (iOS specifics)

Everything in this section behaves identically in Safari, Chrome and Edge on iOS — same engine.

### `devicemotion`
```js
window.addEventListener('devicemotion', e => {
  e.acceleration;                 // {x,y,z} m/s², gravity REMOVED (Core Motion fused) — good
  e.accelerationIncludingGravity; // {x,y,z} m/s²
  e.rotationRate;                 // {alpha,beta,gamma} deg/s  (alpha=about Z, beta=about X, gamma=about Y)
  e.interval;                     // ms between samples
});
```
- Rate is typically ~60 Hz on iOS, sometimes lower. **Always use `e.interval` for integration**, never a hardcoded dt.
- `acceleration` (gravity-removed) is genuinely available on iOS — use it directly for the seismograph.
- ⚠️ **Sign conventions for `accelerationIncludingGravity` differ between iOS and the W3C spec / Android.** Do not trust a remembered polarity. Write a one-time calibration test: lay the phone flat, screen up, and log the vector. Derive your sign constant from that, and put a comment recording what you observed.

### `deviceorientation`
```js
window.addEventListener('deviceorientation', e => {
  e.alpha; e.beta; e.gamma;   // degrees
  e.webkitCompassHeading;     // degrees, WebKit only — heading (true north when location available)
  e.webkitCompassAccuracy;    // degrees of estimated error; NEGATIVE means invalid/uncalibrated
});
```
- `webkitCompassHeading` is a WebKit feature, so it is present in all three iOS browsers — and absent everywhere else. Feature-detect it rather than assuming.
- `webkitCompassAccuracy` is the key extra signal for Instrument 7. Large or negative = magnetic interference or needs calibration.
- `deviceorientationabsolute` does **not** fire on iOS. Use `deviceorientation` + `webkitCompassHeading`.

### Geolocation
```js
navigator.geolocation.watchPosition(cb, err, {
  enableHighAccuracy: true, maximumAge: 0, timeout: 15000
});
// coords: latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed
```
- `heading` and `speed` are **null when stationary** — GPS-derived, not compass. Fall back to `webkitCompassHeading` for heading.
- `altitude` is ±10–30 m. Label it as unreliable.
- iOS asks for location per-browser, and Chrome/Edge additionally require the *app* to hold the OS location permission. A user who denied Chrome location at the OS level gets a failure your page cannot distinguish from a page-level denial. Show both remedies in the error state.

### Audio
See §5 for the constraint profiles. Beyond those:
- Read `audioCtx.sampleRate` at runtime (usually 48000, sometimes 44100). All bin math depends on it. Never hardcode.
- Nyquist at 48 kHz is 24 kHz, so the 15–22 kHz band is usable. At 44.1 kHz your ceiling is ~20 kHz — narrow the chirp accordingly.
- **The iPhone hardware mute switch silences Web Audio output in all iOS browsers.** If the user has it flipped, sonar and Doppler emit nothing. Detect "no signal received at the emit frequency" and show a "check mute switch" hint.
- Use **AudioWorklet** for anything sample-accurate (sonar). `ScriptProcessorNode` is deprecated and glitches. AudioWorklet works on iOS 14.5+.
- The bottom speaker and bottom mic are physically adjacent — direct coupling will dominate any sonar return. Plan to blank the first ~1–2 ms of the correlation.

### Camera
```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
});
```
- The `<video>` element **must** have `playsinline` and `muted` or iOS will refuse to play it inline.
- Torch/flash control (`applyConstraints({advanced:[{torch:true}]})`) is **not reliably available on iOS**. Feature-detect with `track.getCapabilities()` and hide any UI that depends on it. Do not build an instrument that requires it.
- Release the track on screen exit. A leaked camera stream keeps the privacy indicator lit in every browser.

---

## 8. Instrument specs

### 2. Geo & navigation — Easy
Display lat/lon (decimal + DMS), accuracy radius, altitude ±accuracy, speed (m/s and km/h), GPS heading. Add a session track log with total distance via haversine. Show a satellite-fix quality indicator derived from `accuracy`.

**Acceptance:** Walk 100 m; logged distance should be within ~10%.

---

### 3. Compass / attitude — Easy
Heading from `webkitCompassHeading`. Pitch/roll from the gravity vector (more stable than raw `beta`/`gamma`):

```
pitch = atan2(-gz, sqrt(gx² + gy²))
roll  = atan2(gy, gx)   // verify axis mapping empirically against a real bubble level
```
Smooth heading with a **circular** EMA (average the unit vectors, not the degrees — otherwise it glitches crossing 0/360).

Show `webkitCompassAccuracy` as a confidence ring.

**Acceptance:** Reads within ~5° of a known-good compass; the bubble level agrees with a real one on a flat table. Verify in all three browsers — this is the cheapest instrument that exercises the orientation permission path.

---

### 4. Seismograph / vibration — Easy
Use `e.acceleration` (gravity already removed). Compute magnitude, high-pass at ~0.5 Hz to kill residual drift, render a scrolling waveform plus a rolling RMS.

Add an FFT over a ~4 s window to show the dominant vibration frequency (usable to ~30 Hz given the ~60 Hz sample rate).

**Label the amplitude as an arbitrary index, not Richter.**

**Acceptance:** Tapping the table produces clear transients; the phone sitting still on a desk reads near zero.

---

### 5. Audio spectrum analyzer — Easy
Acquire the mic with the **`raw`** profile (§5). `AnalyserNode`, `fftSize` 8192–16384, `getFloatFrequencyData`. Log-frequency X axis, dBFS Y axis. Add peak-hold and a dominant-frequency readout (useful as a tuner).

`binHz = sampleRate / fftSize`. Show it in the UI.

**Acceptance:** Play a 440 Hz tone from another device; peak lands within one bin.

---

### 6. Floor-plane rangefinder — Medium ★ most useful

Genuinely metric distance measurement using only the camera and the gravity vector. Works for any point where an object meets the floor.

**Principle:** camera at known height `h` above a flat floor. A ray depressed by angle θ below horizontal hits the floor at horizontal distance `h / tan(θ)`.

**Algorithm:**
1. User enters camera height `h` (default 1.4 m, chest height) — or calibrates once against a known distance.
2. Get gravity unit vector `ĝ` (pointing *down*) in device coordinates, from `accelerationIncludingGravity` low-pass filtered. **Resolve the sign empirically** (§7).
3. User taps a pixel. Convert to normalized coords `u, v ∈ [-1, 1]`, `v` positive upward, relative to the *displayed video frame* (account for CSS object-fit cropping — this is a common bug).
4. Build the ray in device coords. Rear camera looks along device −Z:
   ```
   ray = normalize( u·tan(hfov/2),  v·tan(vfov/2),  −1 )
   ```
5. Depression angle below horizontal:
   ```
   θ = asin( dot(ray, ĝ_down) )
   ```
6. If `θ <= 0` the ray is above the horizon — no intersection; show "no floor solution."
   ```
   horizontal_distance = h / tan(θ)
   slant_range         = h / sin(θ)
   ```

**Calibration:** FOV is the dominant error source, and `getUserMedia` may crop relative to the native camera. Do not hardcode 69°. Build a calibration mode: place an object at a measured distance, tap it, and solve for the FOV that makes the reading correct. Persist to `localStorage`. **Calibrate per browser** — if the WKWebView crop factor differs from Safari's, one stored value will be wrong in the other. Key the stored calibration by a capability fingerprint, not a UA string.

**Accuracy:** a few percent from ~0.5–5 m. Error grows as `1/tan θ`, so it degrades sharply at distance. Show an uncertainty band and refuse to display beyond ~8 m.

**Acceptance:** Objects on the floor at a tape-measured 1 m, 2 m, and 4 m read within 10%.

---

### 7. Magnetic anomaly detector — Medium ★ most surprising

We cannot read field magnitude in any iOS browser. We *can* detect disturbances two ways. Show both.

**Signal A — free and easy:** plot `webkitCompassAccuracy` over time. It degrades near ferrous mass, speakers, motors, and laptops. Negative values mean invalid.

**Signal B — the gyro/compass residual:** the gyroscope is magnetically immune; the compass is not. When they disagree, something is perturbing the field.

1. Get the rotation-rate vector in device coords. Per spec, `alpha` is about Z, `beta` about X, `gamma` about Y:
   ```
   ω = (rotationRate.beta, rotationRate.gamma, rotationRate.alpha)   // (X, Y, Z)
   ```
2. Project onto the vertical to get **yaw rate about true vertical**, valid at any device pose:
   ```
   yawRate = dot(ω, ĝ_down)     // sign per your empirical convention
   ```
   (Do not just use `rotationRate.alpha` — that is only yaw when the phone is flat on its back.)
3. Integrate over a sliding 1–2 s window using `e.interval` for dt → `predictedΔheading`.
4. Compute `actualΔheading` from `webkitCompassHeading`, **unwrapped** across the 0/360 boundary.
5. `residual = actualΔheading − predictedΔheading`.
6. Gyro bias produces a slow constant drift in the residual. Subtract a long EMA (τ ≈ 20–30 s) of the residual rate to detrend. What remains is your **anomaly index**.
7. Also track **static heading variance**: hold still, and if the heading wanders, that is disturbance too.

**Be honest in the UI.** Label it "Magnetic Anomaly — relative index," not a µT reading.

**Known risk:** iOS Core Motion already performs fusion that may partially reject magnetic outliers, damping signal B. **Measure this before building UI around it** — sweep the phone past a speaker magnet and log the raw residual. If signal B turns out to be too smoothed, fall back to signal A alone; it still works. The fusion is the OS's, so the result will be the same in all three browsers — measure once.

**Acceptance:** Sweeping past a fridge magnet or a laptop produces a visible, repeatable spike in at least one of the two signals, distinguishable from the noise floor of an undisturbed sweep.

---

### 8. Ultrasonic Doppler motion detector — Medium

Emit a steady tone, watch for Doppler sidebands caused by movement in the room. **Requires the `raw` mic profile (§5)** — noise suppression will delete your carrier.

1. `OscillatorNode` at ~20 kHz (or ~18 kHz at a 44.1 kHz sample rate), low gain, to `destination`.
2. `AnalyserNode` with `fftSize` 16384 → bin width ≈ 2.93 Hz at 48 kHz.
3. Watch bins either side of the carrier. Doppler shift is `Δf = 2·v·f/c`; at 20 kHz and c = 343 m/s, a 1 m/s motion gives ≈ 117 Hz — about 40 bins. Easily resolvable.
4. Display sideband energy as a motion index, and the sign/asymmetry as approach vs. recede.

**Honest limits:** this detects *gross body movement* at close range. It does **not** detect breathing or heartbeat — those shifts are sub-Hz and buried in the carrier leakage. Do not label it a "life sign detector" in any way that implies it detects a still person.

**Acceptance:** Waving a hand 30 cm from the phone produces a clear sideband; an empty still room does not.

---

### 9. ML depth scanner — Hard ★ best visual

Monocular depth estimation on live camera frames.

**Easiest path:** `@huggingface/transformers` (Transformers.js) with the `depth-estimation` pipeline and `onnx-community/depth-anything-v2-small`, WebGPU device.

```js
import { pipeline } from '@huggingface/transformers';
const device = ('gpu' in navigator) ? 'webgpu' : 'wasm';
const depth = await pipeline('depth-estimation',
  'onnx-community/depth-anything-v2-small', { device, dtype: 'q8' });
```

**Notes:**
- **WebGPU availability is the one place the three browsers may genuinely diverge** — Safari 26+ has it on by default; whether WKWebView exposes it to Chrome/Edge on the same iOS version needs verifying on device (§11). Detect `'gpu' in navigator` and fall back to WASM. Tell the user which backend is running and that WASM will be slow.
- Downscale input to 256×256 or 384×384 before inference. Full 518×518 is too slow on a phone.
- Expect roughly 5–15 FPS on recent iPhone hardware via WebGPU; single-digit or worse on WASM. Run inference in a loop decoupled from the render loop and show the latest available map.
- Model download is ~25–50 MB. Cache it (Transformers.js uses the Cache API) and show a first-run progress bar. **The cache is per-browser** — a user who tries the app in both Safari and Chrome downloads it twice.
- Output is **relative inverse depth**, not meters. Say so in the UI.
- **Per-frame min/max normalization causes severe flicker.** Smooth the normalization bounds with an EMA across frames.
- False-color with a perceptually uniform ramp (viridis/turbo/inferno) — do not use a raw hue rotation.

**Stretch:** use Instrument 6's metric floor distances to fit a scale+shift that converts the relative map into approximate metric depth. Two or three tapped floor points are enough to solve a least-squares fit. Clearly label the result as estimated.

**Acceptance:** A hand held in front of the camera renders clearly nearer than the wall behind it, with stable coloring frame to frame.

---

### 10. Acoustic sonar rangefinder — Hard, build last

Matched-filter time-of-flight ranging. **Requires the `raw` mic profile (§5)** — echo cancellation will cancel your own chirp.

1. **Chirp:** linear FM sweep 15 → 22 kHz over ~10 ms, Hann-windowed. Generate into an `AudioBuffer`, play via `AudioBufferSourceNode`.
2. **Capture:** mic through an `AudioWorkletProcessor` into a ring buffer. Record the exact `currentTime` at which the chirp was scheduled.
3. **Correlate:** cross-correlate the captured block against the reference chirp (FFT multiply + inverse FFT is far faster than direct convolution).
4. **Blank the direct path:** the speaker→mic leak is only centimeters and will be the largest peak. Zero the first ~1–2 ms of the correlation output before peak-picking.
5. **Range:**
   ```
   distance = (lagSamples / sampleRate) * 343 / 2
   ```
   At 48 kHz, one sample = 7.15 mm of path = **3.6 mm of range resolution**.
6. Average 4–8 pings and take the median to suppress spurious peaks.

**Realistic expectation:** 0.2–3 m against a large flat surface in a quiet room. It is finicky and pointing-sensitive. Present it as an A-scope trace (correlation amplitude vs. range) rather than a single number — the trace is both more honest and more tricorder-like.

**Acceptance:** Pointing at a wall at a tape-measured 1 m and 2 m produces a correlation peak at the right range, repeatably.

---

## 9. Cross-cutting UI requirements

- **Screen lifecycle is the core abstraction.** Activating an instrument acquires what it needs; leaving it releases everything. Write this once, in a base class or a hook, and make every instrument use it. Most resource-leak bugs in this app will be a missed release path.
- **Only one instrument active at a time** by default. The camera + ML model + audio worklet all running together will thermally throttle the phone and drain the battery fast. Provide an explicit multi-panel mode if you want it, with a warning — and note that two screens needing different mic profiles (§5) genuinely cannot coexist.
- **Release resources on screen switch** — stop media tracks, disconnect audio nodes, remove event listeners, cancel animation frames. Leaked camera or mic streams keep the privacy indicator lit and read as spyware.
- **Wake lock** whenever any instrument is active; re-acquire on `visibilitychange`. Feature-detect — it may be absent.
- **Vibration API** for haptic feedback — `navigator.vibrate()` is **not supported on iOS in any browser**. Feature-detect and degrade silently; do not build it into the interaction model.
- **Every derived/uncalibrated readout must be visibly labeled.** Relative index, dBFS, estimated, ±uncertainty. The fun of this project is that the numbers are real; do not undermine that with fake precision.
- **Use `dvh`, not `vh`.** Chrome and Edge on iOS have a URL bar that collapses on scroll and a different chrome height from Safari. Recompute layout on `resize` and `orientationchange`.
- Landscape and portrait both need to work; recompute the FOV/ray mapping on `orientationchange`.
- Add a **diagnostics screen** listing the detected capabilities (§1), `audioCtx.sampleRate`, the resolved gravity sign convention, and the active depth backend. It costs an hour and will save days of remote debugging across three browsers.

---

## 10. Suggested milestones

- **M1** — Boot gate + HTTPS serving + Geo + Compass + Seismograph + Spectrum, plus the diagnostics screen. This is a complete, useful app. **Verify M1 on Safari, Chrome and Edge before moving on** — the permission and secure-context paths are the only genuinely browser-sensitive parts of the whole project, and you want them proven early.
- **M2** — Floor-plane rangefinder with calibration flow, and the magnetic anomaly detector. Measure the Core Motion damping risk (Instrument 7) *early* — it is the one open technical question in this doc.
- **M3** — Ultrasonic Doppler.
- **M4** — ML depth scanner. Check the WebGPU matrix (§1) before committing to the WebGPU path.
- **M5** — Sonar, if M1–M4 are solid.

---

## 11. Open questions for the implementer to resolve empirically

Engine-level questions — measure once, the answer holds for all three browsers:

1. `accelerationIncludingGravity` sign convention on the actual test device (§7).
2. Whether iOS Core Motion's fusion damps the gyro/compass residual enough to kill Instrument 7's signal B.
3. Actual `audioCtx.sampleRate` on the test device (48 k vs 44.1 k) — determines the ultrasonic ceiling.
4. Whether `track.getCapabilities()` exposes `exposureTime` / `iso` on this iOS version. If it does, a **calibrated lux meter** becomes possible via `L ≈ (N²/t)·(K/S)` with fixed aperture N and K ≈ 12.5 — worth adding as a bonus instrument. If not, ship a relative light meter from mean frame luminance.

Browser-level questions — check all three:

5. Real-world FOV of the `getUserMedia` video stream vs. the native camera (crop factor), **and whether it differs between Safari and WKWebView**. Drives Instrument 6 calibration and whether one stored calibration can be shared.
6. Whether WebGPU is exposed to Chrome and Edge on the target iOS version, or only to Safari (§1, Instrument 9).
7. Whether Wake Lock is available in all three.
8. Whether the motion permission prompt behaves identically in Chrome and Edge, and what the denial-recovery path actually is in each.

---

## 12. If an Android or desktop device ever becomes available

These unlock immediately and are worth knowing about, but **do not build for them now** — and note that none of them arrive by supporting Chrome or Edge *on iOS*, because those are WebKit (§1). They require the real Blink/Gecko engine on another platform: `Magnetometer` and the rest of the Generic Sensor API, WebXR depth sensing + `XRLightProbe`, Web NFC, `BarcodeDetector`, Battery Status, and — the big one — **Web Bluetooth**, whose standard Environmental Sensing service (`0x181A`) exposes temperature, humidity, pressure, UV index, and magnetic flux density from a cheap external BLE sensor pod. That is the path to a "real" tricorder with the sensors the browser refuses to provide.
