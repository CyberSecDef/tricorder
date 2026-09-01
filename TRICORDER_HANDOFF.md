# Web Tricorder — Implementation Handoff

**Target:** A browser-based "tricorder" sensor suite that runs on **iOS 26+**, in **Safari, Chrome and Edge**.
**Status:** M1 and M2 built. Instruments 1–7 plus a diagnostics screen and a measurement probe. Instruments 8–10 remain.
**Prime constraint:** iOS only. Do not assume any Android/desktop-Chrome-only API.
**Reference device:** iPhone, iOS 26.6.1, tested in Chrome. Safari and Edge not yet exercised.

> **This document has been updated from measurements.** It began as a set of
> predictions written before anything was built. Where a prediction has since
> been tested on hardware, the result is recorded inline and marked
> **MEASURED**. Where a prediction turned out to be wrong or incomplete, the
> correction is marked **CORRECTION** and the original reasoning is kept, so a
> future reader can see why the wrong turn was tempting. Everything not so
> marked is still a prediction and should be treated as one.

---

## 0. Read this first — the seven things that will waste your time

1. **On iOS, Chrome and Edge *are* Safari.** App Store rules require every iOS browser to render with WKWebView — Apple's WebKit. Chrome for iOS is not Blink; Edge for iOS is not Blink. Supporting all three does **not** widen the API surface by one function. It changes permissions, installability, and a few newer features. See §1.
2. **iOS has no WebXR, no Web Bluetooth, no Web NFC, no WebUSB, no Web Serial, no Battery Status API, and no Generic Sensor API** (`Accelerometer`, `Magnetometer`, `AmbientLightSensor`, `Gyroscope` classes all absent) — *in every browser on the platform.* Everything here uses `DeviceMotionEvent`, `DeviceOrientationEvent`, `getUserMedia`, Web Audio, and Geolocation. If you find yourself reaching for `new Magnetometer()`, stop.
3. **The raw magnetometer is not accessible.** Not behind a flag, not in any iOS browser. We detect *anomalies* via a gyro/compass residual instead (Instrument 7). Do not promise µT readings anywhere in the UI. **MEASURED, and the news is bad:** on iOS 26.6.1 the fused heading exposed to the web does not respond to a magnet *at all* — not to a large one, not at any distance or angle, and not in Apple's own Compass app either. Instrument 7 is built and demonstrably sensitive to 0.067°, and detects nothing, so it is not in the rail. An earlier session did record a strong response and has not reproduced; the whole story is in §8.7. Treat Instrument 7 as unavailable until someone shows otherwise.
4. **iPhone LiDAR is not accessible from the web.** ARKit only. Depth comes from an ML model (Instrument 9).
5. **Motion sensors require an explicit permission call inside a real user gesture**, and the page must be served over **HTTPS** (a phone cannot use `localhost`). See §3 and §4.
6. **Audio DSP defaults will destroy the sonar and Doppler instruments** — but only those. Because this app is a set of screens, mic constraints are a *per-instrument* concern, not a global one. See §5.
7. **MEASURED — WebKit only pulls an audio graph that reaches the destination.** An `AnalyserNode` connected to nothing downstream is never fed. `getFloatFrequencyData` returns a flat `-Infinity` forever, with no error and no warning. Chromium processes such a node regardless, so this reproduces *only* on the target platform and never in desktop testing. It cost a full debugging cycle on Instrument 5. Terminate every analysis chain at `destination` through a zero-gain node. See §5.

---

## 1. Browser support on iOS

All three targets share one engine, so treat "does this work?" as a question about the **iOS version**, not the browser name. A device on iOS 18 running Chrome has the same WebKit as that device's Safari.

**Target floor is now iOS 26+.** That clears every version gate this document originally hedged against: Wake Lock (16.4+), WebGPU (Safari 26+), AudioWorklet (14.5+), `getUserMedia` in WKWebView (14.3+). It does **not** remove the need to feature-detect. The reason to detect was never the OS version — it is that Chrome and Edge on iOS are WKWebView, and what an embedded web view exposes is not guaranteed to match what Safari exposes at the same version. A capability missing at iOS 26 is a finding worth recording, not a shrug.

> **EU footnote:** iOS 17.4+ permits alternative browser engines in the EU via BrowserEngineKit. In practice neither Chrome nor Edge ships a non-WebKit iOS build. If that changes, this document's constraints get *looser*, never tighter — nothing here breaks.

### What is identical across Safari / Chrome / Edge on iOS

`DeviceMotionEvent`, `DeviceOrientationEvent` and their `requestPermission()` gate, `webkitCompassHeading` / `webkitCompassAccuracy`, Geolocation, Web Audio including AudioWorklet, `getUserMedia` for camera and mic (WKWebView has had these since iOS 14.3), Canvas/WebGL, and the absence of every API listed in §0.2.

### What actually differs

| Concern | Safari | Chrome / Edge on iOS | Consequence |
|---|---|---|---|
| **Add to Home Screen** (standalone PWA) | Yes | **No** — cannot install a standalone web app | The manifest and standalone permission context only matter for Safari. Chrome/Edge users run it as a tab. |
| Permission prompt UX | Native Safari sheet | WKWebView sheet, hosted by the app | Same API, different wording. Do not scrape prompt text. |
| Settings toggle for motion | Settings → Safari → Motion & Orientation Access | Same WebKit setting, but users will not think to look under "Safari" | Troubleshooting copy must say this explicitly. |
| Wake Lock | 16.4+, so present at the iOS 26 floor | Follows the same WebKit version — **still unconfirmed in Edge** | Degrade silently if absent. |
| WebGPU (Instrument 9) | 26+, on by default | **MEASURED: present in Chrome on iOS 26.6.1.** WKWebView does expose it | Commit to the WebGPU path; keep the WASM fallback as a safety net rather than an expected route. Edge still unconfirmed. |
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

**As built:** `src/lib/capabilities.ts` probes all of the above, `src/lib/platform.ts` records what the iOS 26 floor guarantees, and the diagnostics screen compares the two — a capability that *should* be present but is not gets reported as a finding rather than rendered as a neutral "no".

---

## 2. Scope

Build a single-page PWA presenting a set of "instruments," each a self-contained **screen**. Aesthetic is up to you (LCARS-ish is the obvious call), but **signal correctness matters more than chrome** — every readout must come from a real measurement, and anything derived/uncalibrated must be labeled as such in the UI.

**As built:** full LCARS — swept elbows, the canonical TNG palette, Antonio for display type with a condensed-sans fallback stack.

### Instruments, in recommended build order

| # | Instrument | Difficulty | Depends on | Status |
|---|---|---|---|---|
| 1 | Permission/boot gate | — | — | ✅ built, works on device |
| 2 | Geo & navigation (GPS) | Easy | Geolocation | ✅ built, passes on device |
| 3 | Compass / attitude | Easy | DeviceOrientation | ✅ built, within 2° of a known-good compass; bubble within 2° of a spirit level |
| 4 | Seismograph / vibration | Easy | DeviceMotion | ✅ built, passes on device |
| 5 | Audio spectrum analyzer | Easy | Web Audio | ✅ built; needed the §0.7 fix before it produced anything |
| 6 | Floor-plane rangefinder | Medium | Camera + DeviceMotion | ✅ built, **accurate to inches** after two-point calibration |
| 7 | Magnetic anomaly detector | Medium | DeviceOrientation + DeviceMotion | ⛔ built and correct, but **no signal exists on iOS 26.6.1** — not in the rail (§8.7) |
| 8 | Ultrasonic Doppler motion | Medium | Web Audio | ✅ built and **verified on device** — detects motion and its direction |
| 9 | ML depth scanner | Hard | Camera + ONNX/WebGPU | not started; WebGPU path confirmed available |
| 10 | Acoustic sonar rangefinder | Hard | Web Audio (AudioWorklet) | not started |
| — | Diagnostics | — | — | ✅ built (§9) |
| — | Magnetic residual probe | — | DeviceOrientation + DeviceMotion | ✅ built — the harness that answered §11 q.2 |

Ship 1–5 as a working v1 before touching 6+.

**Retained, and it was the right call.** Building strictly in this order meant every hard instrument arrived on a foundation that had already been checked on hardware. Instrument 6 could not have been trusted before the gravity sign convention was measured (§11 q.1) and the bubble level had been checked against a real spirit level — both of which came free from finishing 3 first.

### Explicit non-goals
- Absolute SPL in dB — we cannot calibrate a phone mic without a reference. Show dBFS or a relative scale.
- Richter magnitude — the accelerometer is not a seismometer. Show a relative/arbitrary index.
- Metric absolute depth from the ML model — it outputs *relative* inverse depth.
- Barometric pressure, temperature, humidity, radiation, NFC, battery — no API exists on iOS in any browser. Don't fake them.

---

## 3. Tech stack & structure

**Recommended:** Vite + TypeScript, vanilla DOM or a thin framework. Keep dependencies minimal — every extra MB hurts on a phone over a tunnel.

**As built:** Vite + TypeScript, vanilla DOM, no framework. The instruments are
canvas-heavy with per-frame numeric readouts, which is exactly the case where a
VDOM buys nothing against a 60 Hz sensor stream. Runtime dependencies: none.
Bundle is ~36 kB gzipped with seven instruments in it. `devDependencies` are
Vite, TypeScript and `@types/node`.

```
src/
  sensors/           # raw sensor streams, one module each; no UI
    stream.ts        # SensorStream: refcounted multi-consumer source
    motion.ts        # devicemotion -> {accel, accelG, omega, dt}
    orientation.ts   # deviceorientation -> {alpha,beta,gamma,heading,headingAccuracy}
    gravity.ts       # low-passed gravity-down unit vector, pitch, roll (§7)
    residual.ts      # gyro/compass residual — shared by Instrument 7 and the probe
    geo.ts           # watchPosition wrapper + fix-quality helpers
    audio.ts         # per-profile mic acquisition (§5). NOT a shared stream.
    camera.ts        # getUserMedia video + object-fit-aware tap mapping
  instruments/       # one screen per module; consumes sensors/, owns its own math
  lib/
    permissions.ts   # the single-gesture unlock (see §4)
    capabilities.ts  # feature detection (see §1)
    platform.ts      # what the iOS 26 floor guarantees, for comparison
    dsp.ts           # FFT, Hann, high-pass, ring buffer, haversine
    rangefinder.ts   # floor-plane geometry + calibration solvers (§8.6)
    vec.ts           # 3-vector helpers, circular EMA, angle unwrapping
    wakelock.ts      # with re-acquire on visibilitychange
    storage.ts       # namespaced localStorage that survives private mode
  ui/
    screen.ts        # Instrument base class — the lifecycle (below)
    app.ts           # shell + router; serialises screen switches
    dom.ts, lcars.css
```

**Two modules earned their place the hard way.** `sensors/residual.ts` exists
because the gyro/compass residual is used by both Instrument 7 and the probe
that validated it, and the subtleties in it — projecting yaw onto gravity
rather than reading `alpha`, resetting the detrend filter between sessions —
were expensive enough to be worth having in exactly one place. `lib/
rangefinder.ts` is separated from its instrument purely so the geometry can be
tested against closed-form cases; there are 16 such tests and they caught two
real errors.

### Screens own their resources

Because each instrument is a separate screen, the lifecycle is: **activate → acquire → run → release**. Motion and orientation are cheap, always-on, shared streams. Camera and mic are **acquired by the active screen and released on exit.**

Each sensor module exposes subscribe/unsubscribe and is safe for multiple consumers — several instruments read `devicemotion` simultaneously and you only want one listener. But the mic is different: see §5, different instruments need *incompatible* mic constraints, so `audio.ts` must acquire per-profile rather than hand out one shared stream.

**As built,** this is enforced rather than trusted. The `Instrument` base class
in `ui/screen.ts` registers every subscription, listener, interval and
animation frame, and tears them all down in reverse order on unmount. No
instrument is asked to remember its own cleanup, because the one that forgets
leaves the privacy indicator lit. `app.ts` also serialises screen switches
through a promise chain — `build()` is async for any screen that awaits
`getUserMedia`, so two fast taps could otherwise mount two screens at once.

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

**MEASURED:** the boot gate worked first time on iOS 26.6.1 in Chrome, with no
surprises. This section's advice held up exactly as written. Denial recovery
(§11 q.8) has still never been exercised, because nothing has been denied yet —
which is worth deliberately testing rather than waiting for a user to hit it.

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

### MEASURED — terminate the analysis graph at the destination

This is the single most expensive thing discovered while building M1, and it is
not in any of the obvious places to look.

**WebKit only pulls an audio graph that reaches `ctx.destination`.** An
`AnalyserNode` hanging off a `MediaStreamAudioSourceNode` with nothing
connected downstream is never fed. `getFloatFrequencyData` fills the array with
`-Infinity`, forever, and no error is raised anywhere. The spectrum analyzer
rendered a perfectly composed, permanently empty display.

It reproduces **only on the target platform**. Chromium processes a dangling
analyser regardless, so the headless test suite passed throughout and the bug
appeared for the first time on a phone.

The instinct that causes it is sound: connecting the microphone to the speakers
creates feedback, so you deliberately do not connect it. The fix keeps that
property while making the graph live:

```js
const mute = ctx.createGain();
mute.gain.value = 0;          // emits nothing, so no speaker-to-mic path
analyser.connect(mute);
mute.connect(ctx.destination); // but the graph now terminates, so it is pulled
```

Instruments 8 and 10 both analyse microphone input and will hit this the moment
they are built. Do it in the acquisition path once.

**Also worth building:** distinguishing "the room is silent" from "the pipeline
is dead" needs two independent pieces of evidence, because either alone gives
false positives. Time-domain RMS of exactly zero can also come from a muted or
synthetic source; every frequency bin at `-Infinity` is the signature of an
analyser that is never fed. Requiring both is what separates the two cases, and
without that distinction a user staring at a flat display has no idea whether
to check their permissions or turn up the volume.

---

## 6. Serving it (you cannot skip this)

iOS requires a **secure context** for motion, geolocation, camera, and mic — in all three browsers. `http://<lan-ip>:5173` will silently fail: events just never fire, with no error. This misleads people for hours.

Pick one:
- **Best for iteration:** `vite --host` + a tunnel that terminates TLS — `cloudflared tunnel --url http://localhost:5173`, `ngrok http 5173`, or Tailscale Funnel.
- **Best for real use:** static deploy to Cloudflare Pages / Netlify / Vercel / GitHub Pages.
- **mkcert** with the CA installed and trusted on the iPhone works but is fiddly, and each browser trusts the profile differently. Only bother if offline.

### CORRECTION — the local CA route is the good one, not the fallback

This document listed a local CA third and called it fiddly. In practice it was
the fastest to set up and has been completely reliable, and it is what this
project uses. No tunnel, no third party, no rotating URL, and it works with the
laptop offline.

`scripts/make-certs.sh` builds it with plain `openssl` — `mkcert` is not needed
and is one less thing to install. It issues a private CA plus a leaf covering
`<hostname>.local`, every global IPv4 the machine currently holds, and
`localhost`, so the phone can reach the dev server over whichever network the
two happen to share. `npm run serve-ca` then serves *only* the public CA
certificate over plain HTTP, which is necessary rather than sloppy: the phone
cannot trust the HTTPS origin until it has installed that certificate, so
bootstrapping over TLS is circular.

Two things make this work smoothly, and both are easy to miss:

- **Bonjour removes the DHCP problem.** If the dev machine runs avahi, the
  phone resolves `<hostname>.local` natively. The address survives lease
  changes, so the certificate does not need reissuing every time the router
  has an opinion.
- **Installing the profile is not enough.** iOS needs *two* steps, and the
  second is the one everyone forgets: Settings → General → VPN & Device
  Management → install the profile, and then Settings → General → About →
  **Certificate Trust Settings** → enable full trust for the CA. Without the
  second, Safari still rejects the certificate and you will be convinced the
  certificate is wrong. WKWebView uses the same system trust store, so one
  install covers Safari, Chrome and Edge.

Re-running the script reuses an existing CA, so a changed LAN IP means
re-issuing the leaf but *not* re-installing anything on the phone.

Keep the private key out of git. `.gitignore` should carry `certs/*` with an
exception for the README, not a blanket `certs/`.

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
- Rate is typically ~60 Hz on iOS, sometimes lower. **Always use `e.interval` for integration**, never a hardcoded dt. **MEASURED:** ~60 Hz on the reference device, with enough jitter to be worth clamping — an absent or stale `interval` silently corrupts every integration downstream, so sanity-check it against wall-clock before using it.
- `acceleration` (gravity-removed) is genuinely available on iOS — use it directly for the seismograph. **MEASURED:** confirmed, and the seismograph reads near zero at rest as predicted.
- ⚠️ **Sign conventions for `accelerationIncludingGravity` differ between iOS and the W3C spec / Android.** Do not trust a remembered polarity. Write a one-time calibration test: lay the phone flat, screen up, and log the vector. Derive your sign constant from that, and put a comment recording what you observed.

  **MEASURED (§11 q.1 — answered).** iPhone / iOS 26.6.1, flat on a table screen
  up: `accelerationIncludingGravity` reads **(−0.03, 0.21, −9.80)**. `z` is
  negative, so this engine reports the **iOS convention**, and with device `+Z`
  pointing out of the screen the gravity-down unit vector is
  `+normalize(accelG)` — sign constant **+1**.

  This confirmed the default rather than overturning it, which is exactly why
  it was worth measuring: the two conventions differ only in sign, so a wrong
  guess produces no error, no warning and no obviously silly number. It
  silently inverts pitch, roll, and every ray derivation in Instrument 6. The
  app resolves it at runtime through a calibration on the diagnostics screen,
  persists the result, and flags every gravity-derived readout as unverified
  until it has been run.

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
- **MEASURED — `webkitCompassAccuracy` is a gate, not just a signal.** On the
  reference device it ranges from a floor of 10° to 89°. At 89° the compass is
  effectively uncalibrated and **the heading wanders 60° entirely on its own**,
  with the phone motionless on a table. Any instrument built on heading must
  refuse to report above roughly 20°, and must say why — a figure-eight for ten
  to fifteen seconds brings it down. This is not a nicety: at 89° accuracy the
  compass's own drift is an order of magnitude larger than a neodymium magnet's
  effect, so every derived reading is measuring the compass rather than the
  world.
- **MEASURED — iOS recalibrates the magnetometer while you use it.** Accuracy
  improved from 89° to 63° *during* one two-run experiment, which made the two
  runs incomparable. Any paired measurement must check that accuracy did not
  drift materially between them.
- **MEASURED — `deviceorientation` fires at ~60 Hz even with the device
  perfectly still.** Worth knowing, because a frozen heading is otherwise
  ambiguous between "the fusion is rejecting the magnetometer" and "no events
  are arriving at all". Count events before concluding anything from a flat
  signal.

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
- ⚠️ **The analysis graph must terminate at `destination` or WebKit never feeds it.** See §5 — this is the one that will cost you a debugging session, and it will not reproduce on a desktop.
- **MEASURED — 48000 Hz on the reference device.** Nyquist 24 kHz, so the full 15–22 kHz band is usable. Instrument 8 can put its carrier at 20 kHz and Instrument 10 can sweep to 22 kHz; neither needs the narrowed 44.1 kHz variant. Read it at runtime anyway — it is a property of the hardware and the audio route, not of the app.

### Camera
```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
});
```
- The `<video>` element **must** have `playsinline` and `muted` or iOS will refuse to play it inline.
- Torch/flash control (`applyConstraints({advanced:[{torch:true}]})`) is **not reliably available on iOS**. Feature-detect with `track.getCapabilities()` and hide any UI that depends on it. Do not build an instrument that requires it.
- Release the track on screen exit. A leaked camera stream keeps the privacy indicator lit in every browser.
- **MEASURED:** the stream from `getUserMedia` on the reference device is 1280×720. The `playsinline` + `muted` requirement is real; both attributes and both properties are set in `sensors/camera.ts` because setting only the attributes is not always enough.

---

## 8. Instrument specs

### 2. Geo & navigation — Easy
Display lat/lon (decimal + DMS), accuracy radius, altitude ±accuracy, speed (m/s and km/h), GPS heading. Add a session track log with total distance via haversine. Show a satellite-fix quality indicator derived from `accuracy`.

**Acceptance:** Walk 100 m; logged distance should be within ~10%.

**MEASURED — passes.** Note that a drift filter is essential and is not
obvious from the spec above: a stationary phone accumulates hundreds of metres
of GNSS wander if every fix is integrated. Discard fixes coarser than ~30 m,
and steps shorter than half the reported accuracy radius — a step smaller than
the uncertainty is indistinguishable from noise.

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

**MEASURED — passes, within 2° on both halves.** Do both halves. The bubble
check is what validates the pitch/roll axis mapping, and Instrument 6's entire
ray derivation rests on that mapping being right — so a compass that reads
correctly while the level is silently inverted would poison the rangefinder
with no visible symptom.

---

### 4. Seismograph / vibration — Easy
Use `e.acceleration` (gravity already removed). Compute magnitude, high-pass at ~0.5 Hz to kill residual drift, render a scrolling waveform plus a rolling RMS.

Add an FFT over a ~4 s window to show the dominant vibration frequency (usable to ~30 Hz given the ~60 Hz sample rate).

**Label the amplitude as an arbitrary index, not Richter.**

**Acceptance:** Tapping the table produces clear transients; the phone sitting still on a desk reads near zero.

**MEASURED — passes.** Two implementation notes: draw the trace right-anchored
so it scrolls like a chart recorder rather than compressing into a sliver while
the buffer fills, and decay peak-hold *exponentially* — a fixed per-second
subtraction zeroes the peak instantly whenever the signal is small, which for
an auto-ranging index is most of the time.

---

### 5. Audio spectrum analyzer — Easy
Acquire the mic with the **`raw`** profile (§5). `AnalyserNode`, `fftSize` 8192–16384, `getFloatFrequencyData`. Log-frequency X axis, dBFS Y axis. Add peak-hold and a dominant-frequency readout (useful as a tuner).

`binHz = sampleRate / fftSize`. Show it in the UI.

**Acceptance:** Play a 440 Hz tone from another device; peak lands within one bin.

**MEASURED — passes, but only after the §0.7 graph-termination fix.** Before
that it displayed nothing at all, with no error. Two further notes: seed the
peak search *inside* the search range or the DC bin wins every time and the
readout sits at 0.0 Hz forever; and search only for local maxima above ~40 Hz,
because the monotonic low-frequency rumble skirt is genuinely the tallest thing
on screen and is never the note you are looking for.

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

### CORRECTION — one known distance is not enough

The single-point calibration above is **not sufficient, and is actively
dangerous**, because it cannot separate the two unknowns.

Uncalibrated on the reference device, a tape-measured 2.00 m read **1.76 m**
— 12% low. That is explained equally well by a field of view that is too wide
*or* a camera height that is too small: at the entered 1.4 m, a true height of
`1.4 / 0.88 = 1.59 m` fits the same observation exactly. Solving for FOV while
the height is wrong absorbs the height error into the FOV, and the result reads
*perfectly at its own calibration distance and wrongly at every other one*
while looking authoritative. A test in the repo demonstrates it: a one-point
fit with the height 0.22 m out is exact where calibrated and 10.6% off at 2.7 m.

**Use two points and solve for both.** Taking `h` from the first equation and
substituting into the second leaves one equation in the field of view alone:

```
h = D₁ · tan θ₁(f)          ⇒     tan θ₁(f) / tan θ₂(f) = D₂ / D₁
```

Solve that for `f` by bisection, then `h` follows directly. `lib/rangefinder.ts`
implements this as `solveFovAndHeight()`.

Three traps in implementing it, all of which cost time:

1. **A centre tap carries no FOV information at all.** At the exact centre the
   view ray *is* the optical axis whatever the lens is doing. This is a trap
   rather than an edge case, because centring the target is precisely what
   anyone aiming a camera does by reflex. Guard the single-point path against
   it. Do **not** guard the two-point path — there a central tap is perfectly
   good as one of a pair, pinning tilt and height while the off-centre one
   carries the optics.
2. **A wide search bracket will hit rays above the horizon.** Scanning FOV from
   20° to 130° puts a shallow tap above the horizon at one end, where there is
   no solution. Scan for a sub-interval where both taps resolve and the ratio
   crosses the target, rather than testing the endpoints and giving up.
3. **The conditioning depends on where the taps fall in the FRAME, not on how
   far apart the targets are.** This is the one that misleads. An intuitive
   rule of "use distances at least 1.6× apart" is a proxy for the wrong
   quantity: tilting the phone between shots changes the depression angle
   without exercising the lens at all, so two taps at similar frame positions
   leave the ratio nearly flat in `f` and a 1% distance error swings the answer
   by tens of degrees. Frame one target low, the other near the middle, and
   keep the tilt similar.

**Measure the conditioning rather than guessing it.** Perturb the two input
distances by 1% — about what a tape and a tap are good for — refit, and see how
far the answer moves. That number is the honest 1σ on the calibrated FOV and
should feed the uncertainty band directly instead of some flattering fixed
figure. A fit no better than the uncalibrated guess should be **refused**, not
stored: a calibration that is no improvement, presented as a calibration, is
worse than none.

**Accuracy:** a few percent from ~0.5–5 m. Error grows as `1/tan θ`, so it degrades sharply at distance. Show an uncertainty band and refuse to display beyond ~8 m.

**Acceptance:** Objects on the floor at a tape-measured 1 m, 2 m, and 4 m read within 10%.

**MEASURED — passes.** After two-point calibration with both distances taken at
the same camera height, readings are accurate **to within inches** at those
ranges, comfortably inside the 10% bar and in line with the few-percent
prediction. Verified in simulation as well: against synthetic optics of 58.0°
and 1.62 m the fit recovers 57.5° and 1.61 m, and a third distance never used
in the fit reads within 0.26%.

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

### ⚠️ RETRACTED — the first answer to §11 q.2 did not reproduce

**Read this before the table below.** The measurement recorded here was real
data, honestly taken, and it is *not reproducible*. A second session on the
same device, with a better noise floor and a much stronger magnet, produced
nothing at all. The current conclusion is at the end of this section. The
original measurement is left in place because it happened and because a future
reader needs to know that this instrument gave a strong positive once.

### The original measurement — observed once, never repeated

A paired experiment on the reference device, phone resting on a table, using
the probe screen built for exactly this:

| | baseline | disturbed |
|---|---|---|
| rotation | 0.85° | 9.18° |
| residual RMS | **0.021°** | 4.68° |
| residual peak | 0.216° | **14.28°** |
| `webkitCompassAccuracy` | 10° | 10° → 26° |

**691× its own noise floor**, against a detection threshold of 4×. At the time
this read as decisive: Core Motion was not rejecting the magnetometer, and
signal B was the strongest signal in the instrument set.

During that excursion the yaw rates were all below 0.1°/s, so the phone was
genuinely still and it was not a handling artifact — and `webkitCompassAccuracy`
moved 10 → 26 at the same moment, which is iOS independently reporting magnetic
interference. Two signals agreeing. That is why it was believed.

Two corrections to what this section assumed, and one caution:

**CORRECTION — the static case is the primary detection mode, not the sweep.**
Framing signal B as "integrate yaw rate and compare against heading change"
makes rotation feel mandatory. It is not, and the sweep is the *harder*
experiment. With the phone still, the predicted heading change is zero and the
residual reduces to *the heading moved while the device did not* — the cleanest
statement of a magnetic anomaly available, with no gyro integration, no
accumulated bias and nothing to detrend. That is where the 0.021° floor comes
from; a sweep will never be that quiet. Build the still case first.

**CORRECTION — signal A is the weaker fallback, not the safer one.** This
section treats A as the dependable backstop if B fails. On the reference device
it is the reverse. `webkitCompassAccuracy` sat at a constant 10 through an 80°
heading excursion in one recording, and in the paired run above it responded
but lagged the residual by seconds and caught only one of two transients. It
corroborates. It does not detect.

**CAUTION — the compass's own drift will swamp everything if you let it.** See
§7: at 89° accuracy the heading wanders 60° unprompted. An anomaly detector
must gate on `webkitCompassAccuracy` and refuse to report above ~20°, or it
will confidently report anomalies that are nothing but an uncalibrated
compass. This is the single most important thing to get right in the
instrument.

**Implementation note that cost a debugging cycle.** A detrend EMA with a 25 s
time constant carries charge across measurement sessions. A genuinely quiet
baseline recorded shortly after a large excursion reported a noise floor of
13.98° when its raw residual never left ±0.07° — an inflation of 627×. Reset
the filter when a session starts, and compute reported statistics from the
recorded raw series rather than from whatever the live filter happens to be
holding. In the live instrument, the bias tracker must additionally **freeze
while triggered**: otherwise it charges up during the event, and when the event
ends the corrected residual swings the other way and sits there for a full time
constant, so the detector reports a phantom anomaly after every real one and
never re-arms.

### MEASURED — the second session, and the current conclusion

Instrument 7 was then built and tested on the same device. It reached a noise
floor of **0.0084°**, better than the probe's, which at the 8× alert threshold
means it fires on a heading disturbance of **0.067°**.

Against that, the following produced **zero response on every readout**:

- a large magnet and a small neodymium magnet;
- brought in slowly from ten feet, and quickly;
- from every angle, including from directly above;
- spun, to vary the field rather than present a static one;
- with the phone still, and while rotating past the magnet.

Decisively, **raw `webkitCompassHeading` never moved at all** — peak deviation
from its reference stayed at exactly 0.0 throughout. The heading was being
reported; it was simply immune. And **Apple's own Compass app showed no
deflection either**, which rules out this app as the cause and points at the
platform.

`webkitCompassAccuracy` did not respond either, so signal A is dead alongside
signal B.

**Current position: Instrument 7 does not work on iOS 26.6.1, and is not in the
navigation rail.** The implementation is correct and demonstrably sensitive;
the input signal is not there. Shipping it would be shipping a detector that
detects nothing, which §2's non-goals rule out explicitly.

**What is genuinely unresolved** is why it worked once. Candidates, none
verified:

- **Position.** The magnetometer is a specific spot, not the whole phone. The
  first session may have happened to hit it.
- **Saturation.** A strong magnet at close range can exceed the sensor's range
  entirely. A saturated reading is obvious garbage that the fusion discards
  outright, whereas a weaker field produces a wrong-but-plausible value that
  propagates. This predicts that closer and stronger performs *worse*, which
  is consistent with the second session but was not observed to reverse at
  distance.
- **MagSafe compensation.** iPhone 12 and later carry a magnet ring, and iOS
  must keep the compass usable with MagSafe accessories attached. Active
  rejection of a strong static nearby field would explain the second session
  precisely — and would make a static permanent magnet the single worst
  stimulus to test with.
- **Calibration state.** The device recalibrates continuously and its
  willingness to trust the magnetometer may vary with it.

**If you want to resurrect this,** the honest test is a *ferrous mass* rather
than a magnet — a cast-iron pan, a steel beam, a filing cabinet — which
distorts the earth's field instead of presenting a dipole, and does not look
like a MagSafe accessory. That is also the realistic detection case for a
tricorder. Both the instrument and the probe are kept in the tree for exactly
this; re-adding either to the rail is one line in `main.ts`.

**Acceptance:** Sweeping past a fridge magnet or a laptop produces a visible, repeatable spike in at least one of the two signals, distinguishable from the noise floor of an undisturbed sweep.

**Not met.** See above.

**Note on test sources:** flexible fridge-door magnets are multipole by design —
alternating stripes millimetres apart — so their field collapses almost
immediately and will not reach the magnetometer. They produce a convincing
false negative. Use a speaker driver, a neodymium magnet, a MagSafe puck or a
laptop hinge, within a few centimetres of the **top** of the phone, which is
where the magnetometer sits.

---

### 8. Ultrasonic Doppler motion detector — Medium

Emit a steady tone, watch for Doppler sidebands caused by movement in the room. **Requires the `raw` mic profile (§5)** — noise suppression will delete your carrier.

1. `OscillatorNode` at ~20 kHz (or ~18 kHz at a 44.1 kHz sample rate), low gain, to `destination`.
2. `AnalyserNode` with `fftSize` 16384 → bin width ≈ 2.93 Hz at 48 kHz.
3. Watch bins either side of the carrier. Doppler shift is `Δf = 2·v·f/c`; at 20 kHz and c = 343 m/s, a 1 m/s motion gives ≈ 117 Hz — about 40 bins. Easily resolvable.
4. Display sideband energy as a motion index, and the sign/asymmetry as approach vs. recede.

**Honest limits:** this detects *gross body movement* at close range. It does **not** detect breathing or heartbeat — those shifts are sub-Hz and buried in the carrier leakage. Do not label it a "life sign detector" in any way that implies it detects a still person.

**Acceptance:** Waving a hand 30 cm from the phone produces a clear sideband; an empty still room does not.

**MEASURED — passes, including direction.** A hand approaching and receding are
distinguished correctly from the sideband asymmetry. Two implementation notes
worth carrying to Instrument 10, which shares this audio path:

- **Carrier presence must be judged relative to the out-of-band noise, never
  against an absolute dBFS threshold.** A quiet room at 20 kHz sits very low,
  so any fixed bar generous enough to admit a real carrier also admits silence.
  In testing, pure noise at −101 dBFS passed a −115 dBFS bar and the instrument
  began learning a quiet floor from nothing — which is exactly the mute-switch
  case the check existed to catch. Comparing against the noise either side of
  the analysis band is self-calibrating across emitter level, media volume,
  room and reflectivity.
- **Reserve Nyquist headroom derived from the bands you actually read, not a
  round number.** A guessed 2 kHz is ample at 48 kHz and leaves 50 Hz at
  44.1 kHz, where the upper sideband and the whole noise reference would run
  past Nyquist — silently biasing the reference low and the SNR high. Sum the
  analysis band, the gap and the reference band instead.

Reporting the index as a sideband-to-carrier power **ratio** rather than as
absolute energy also proved worth it: it is invariant to emitter level and to
how reflective the room is, so one alert threshold means the same thing
everywhere.

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
  **MEASURED:** WebGPU **is** present in Chrome on iOS 26.6.1, so WKWebView does expose it. Commit to the WebGPU path; keep WASM as a genuine fallback rather than an expected route for two browsers out of three.
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

### MEASURED — things worth adding to this list

- **The diagnostics advice was right and then some.** Beyond the capability
  list, the two additions that paid for themselves were live event rates for
  `devicemotion` and `deviceorientation`, and the gravity calibration itself.
  A frozen signal is ambiguous until you can see whether events are arriving
  at all, and the calibration turned §11 q.1 from an argument into a
  measurement.
- **Estimate a noise floor before reporting any derived index.** A number in
  degrees means nothing on its own; the same 14° is either overwhelming or
  invisible depending on what the device does at rest. Measure the floor
  during a quiet period, express the index as a multiple of it, and freeze the
  estimator while triggered so an event cannot raise the floor it is being
  measured against.
- **Reset filters at session boundaries, and compute reported statistics from
  the recorded raw series.** Any long time constant will otherwise carry state
  across a boundary and contaminate whatever comes next. This bit twice, in two
  different instruments.
- **When a screen is a procedure, lay it out as one.** The probe accumulated
  three overlapping sets of instructions in conflicting order and became
  genuinely confusing to follow. Numbered steps in the order they must be
  performed, with the gating check first, fixed it.
- **Separate the maths from the instrument so it can be tested.** The
  rangefinder geometry and the residual computation both live in `lib/` and
  `sensors/` with no UI, and are tested against closed-form cases — a 30°
  depression must give `h·√3`, a synthesised tap must round-trip back through
  the calibration solver. Those tests caught two real errors that would have
  presented on a phone as "the numbers look a bit off".
- **A headless desktop suite will not catch platform bugs, and knowing that is
  the point.** Two of the worst bugs this project has seen — the dangling
  analyser (§5) and the compass drift (§7) — were invisible in Chromium and
  obvious on the phone. Keep the desktop suite for regressions and layout, but
  never let a green run stand in for a device check.

---

## 10. Suggested milestones

- **M1** — ✅ **built.** Boot gate + HTTPS serving + Geo + Compass + Seismograph + Spectrum, plus the diagnostics screen. This is a complete, useful app. **Verify M1 on Safari, Chrome and Edge before moving on** — the permission and secure-context paths are the only genuinely browser-sensitive parts of the whole project, and you want them proven early.
  ✅ **Gate satisfied.** Verified in **Safari, Chrome and Edge** on iOS 26.6.1.
  Everything built works in all three, which is the outcome §1 predicts —
  they share one engine, and the differences are in permissions and
  installability rather than in the API surface. No browser-specific code path
  exists anywhere in the app, and none turned out to be needed.
- **M2** — ✅ **built.** Floor-plane rangefinder with calibration flow, and the magnetic anomaly detector. Measure the Core Motion damping risk (Instrument 7) *early* — it is the one open technical question in this doc.
  The advice to measure early was correct and was followed: a dedicated probe
  screen was built before Instrument 7 existed, and answering q.2 first changed
  the instrument's design substantially (see §8.7). The rangefinder passes its
  acceptance test. **Instrument 7 does not work on this platform** — it is
  built, correct and sensitive, but no signal reaches it, so it is not in the
  rail. The whole story, including a retracted earlier result, is in §8.7.

  **The lesson worth carrying forward:** the probe answered q.2 with a strong
  positive that did not survive a second attempt. One good measurement is not
  a result. Anything that gates a build decision should be reproduced on a
  separate occasion before it is written down as settled — this document said
  "measure once" for engine-level questions, and that was wrong.
- **M3** — ✅ **built and verified on device.** Ultrasonic Doppler, detecting motion and discriminating approach from recede. The sample rate is 48 kHz (§11 q.3), so the carrier goes at 20 kHz with the full band available. Handle the §0.7 graph-termination trap in the emit/analyse path — it will bite here too.
- **M4** — ML depth scanner. Check the WebGPU matrix (§1) before committing to the WebGPU path. **Already checked: WebGPU is present in Chrome on iOS 26**, so the WebGPU path is viable and WASM is a fallback rather than the expected route.
- **M5** — Sonar, if M1–M4 are solid.

---

## 11. Open questions for the implementer to resolve empirically

Status as of the last device session — iPhone, iOS 26.6.1, Chrome.

Engine-level questions — measure once, the answer holds for all three browsers:

1. ✅ **ANSWERED.** `accelerationIncludingGravity` sign convention: flat and
   screen-up reads **(−0.03, 0.21, −9.80)**, so `z` is negative, the engine
   uses the **iOS convention**, and the gravity-down sign constant is **+1**.
   Full reasoning in §7. Confirmed the assumed default, which is precisely why
   it needed measuring — a wrong guess is silent.
2. ⛔ **ANSWERED — negatively. An earlier positive answer here has been
   RETRACTED.** On iOS 26.6.1 the fused heading does not respond to magnetic
   disturbance at all. Instrument 7 reaches a 0.0084° noise floor, fires at
   0.067°, and sees nothing from any magnet at any distance or angle; raw
   `webkitCompassHeading` never moves, and Apple's own Compass app agrees.
   Signal A is dead too.

   A first session *did* record 691× the noise floor with two independent
   signals agreeing, and that has never reproduced. Both the measurement and
   the retraction are in §8.7, along with four candidate explanations, none
   verified. The most promising untried stimulus is a **ferrous mass** rather
   than a magnet.

   Two framing corrections from that work stand regardless, because they are
   about method rather than result: the static case is a better experiment
   than the sweep, and signal A is the weaker signal rather than the safer
   fallback.
3. ✅ **ANSWERED. 48000 Hz**, Nyquist 24 kHz, ultrasonic ceiling 22 kHz usable.
   Instrument 8's carrier can sit at 20 kHz and Instrument 10 can sweep the
   full 15–22 kHz; the narrowed 44.1 kHz variants are not needed on this
   device. Keep reading it at runtime regardless — it depends on the hardware
   and the active audio route, not on the app.
4. ⬜ **STILL OPEN, but now answerable in one tap.** Whether
   `track.getCapabilities()` exposes `exposureTime` / `iso`. If it does, a
   **calibrated lux meter** becomes possible via `L ≈ (N²/t)·(K/S)` with fixed
   aperture N and K ≈ 12.5. If not, ship a relative light meter from mean frame
   luminance. **Diagnostics → Camera capabilities → Probe camera capabilities**
   asks the track directly, lists every key it reports, and states which of the
   two meters is possible. The probe releases the camera immediately rather
   than holding it. (For reference, desktop Chromium reports `exposureTime` but
   not `iso`, so even there only a relative meter is possible.)

Browser-level questions — check all three:

5. 🟡 **MOSTLY ANSWERED.** The real-world FOV is measurable rather than guessed
   — the two-point calibration in §8.6 recovers it along with the camera
   height, stored keyed by capability fingerprint *and* orientation. All three
   browsers now run the rangefinder correctly. What has not been done is a
   numerical comparison of the stored FOV between Safari and WKWebView, so
   whether the crop factor actually differs remains unmeasured. The
   conservative keying means it does not matter in practice: each browser
   calibrates its own.
6. ✅ **ANSWERED.** WebGPU **is** exposed to Chrome on iOS 26.6.1, so it is not
   Safari-only and WKWebView does provide it. Instrument 9 can commit to the
   WebGPU path. Edge unconfirmed but now unlikely to differ.
7. ✅ **ANSWERED.** Wake Lock is available and the app runs correctly in all
   three browsers. The diagnostics screen reports whether it is actually
   *held*, which is the more useful claim than mere availability.
8. 🟡 **MOSTLY ANSWERED.** The motion permission prompt works in all three
   browsers; the boot gate is not browser-sensitive in practice. What is
   **still untested** is the denial-recovery path — nothing has ever been
   denied, so the copy in §4 describing how to recover has never been walked
   through. Worth deliberately denying once per browser rather than finding
   out from a user that the instructions are wrong.

### New questions raised by the work so far

9. Does `webkitCompassAccuracy` have a hard floor of 10° on this hardware? It
   was observed pinned at exactly 10 across long stretches and never went
   below it. If that is a floor rather than a genuine estimate, the gating
   threshold in Instrument 7 is sound but the *corroboration* value of signal A
   is even weaker than §8.7 already suggests.
10. How quickly does compass calibration decay in normal use? If accuracy
    drifts back above the 20° gate within minutes, Instrument 7 needs a
    recalibration prompt rather than a one-time figure-eight, and that changes
    its interaction model.

---

## 12. If an Android or desktop device ever becomes available

These unlock immediately and are worth knowing about, but **do not build for them now** — and note that none of them arrive by supporting Chrome or Edge *on iOS*, because those are WebKit (§1). They require the real Blink/Gecko engine on another platform: `Magnetometer` and the rest of the Generic Sensor API, WebXR depth sensing + `XRLightProbe`, Web NFC, `BarcodeDetector`, Battery Status, and — the big one — **Web Bluetooth**, whose standard Environmental Sensing service (`0x181A`) exposes temperature, humidity, pressure, UV index, and magnetic flux density from a cheap external BLE sensor pod. That is the path to a "real" tricorder with the sensors the browser refuses to provide.

**One qualification, now that Instrument 7 has been measured.** The magnetometer
entry above is less urgent than it looked when this was written. A real
`Magnetometer` would give absolute µT, which the current approach genuinely
cannot, but the gyro/compass residual detects *disturbance* at 691× its noise
floor — which is what the instrument is actually for. Web Bluetooth and the
environmental sensing service remain the real prize, because temperature,
humidity and pressure have no substitute at all.

---

## 13. Where to pick up

Current state: **M1 and M2 built and pushed.** Seven instruments, a diagnostics
screen and a measurement probe. ~36 kB gzipped, no runtime dependencies.

The desktop test suite covers 16 geometry cases plus end-to-end checks for the
rangefinder, Instrument 7, four probe regressions, and a smoke test that mounts
and unmounts all eleven screens. It is a regression net, not evidence about the
platform — see the last bullet of §9.

**In priority order:**

1. **Exercise Instrument 7 on hardware.** It is built entirely from measurements
   but has only ever run against synthetic data. Figure-eight to calibrate, rest
   the phone, let it learn the floor for three seconds, bring a magnet in. The
   floor it learns should land near 0.021°, and the index should settle back
   near 1 once the magnet leaves. If either is wrong, it is fresh in mind and
   cheap to fix.
2. **Run M1 in Safari and Edge.** The §10 gate, still only half satisfied, and
   the only genuinely browser-sensitive part of the project. Closes §11 q.8 and
   the remaining half of q.5 and q.7.
3. **Record the audio sample rate** (§11 q.3). One glance at diagnostics, and
   M3 needs it.
4. **Then M3, the ultrasonic Doppler.** Straightforward next to what M2
   required. The traps are already known: the graph-termination bug in §0.7,
   the mute switch, and the raw mic profile.

**Two small things worth doing when convenient:** check whether
`track.getCapabilities()` exposes `exposureTime`/`iso` (§11 q.4 — a few lines
on the diagnostics screen, and it decides whether a calibrated lux meter is
possible), and confirm the rangefinder's uncertainty band actually brackets the
true distance. The second is what separates a number with a real error bar from
one with a decorative one.
