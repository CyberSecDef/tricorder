# Tricorder

A browser-based sensor suite for **iOS 26+** — Safari, Chrome and Edge. Every
readout comes from a real device measurement, and anything derived or
uncalibrated says so in the UI.

**Target:** iOS 26 or later. Reference device: iPhone on iOS 26.6.1.
That floor clears every version gate the handoff hedged against — Wake Lock
(16.4+), WebGPU (Safari 26+), AudioWorklet (14.5+), getUserMedia in WKWebView
(14.3+). Feature detection stays regardless: the reason to detect is that
Chrome and Edge on iOS are WKWebView, and what an embedded web view exposes is
not guaranteed to match Safari at the same OS version. Core flags any
divergence from the floor as a finding rather than shrugging at it.

Implementation constraints, instrument specs and the open questions live in
[`TRICORDER_HANDOFF.md`](TRICORDER_HANDOFF.md). Section references throughout
the source point back at it.

## Status — complete: all five milestones, all ten instruments

| # | Instrument | State |
|---|---|---|
| 1 | Permission / boot gate | ✅ built |
| 2 | Geo & navigation | ✅ built |
| 3 | Compass / attitude | ✅ built |
| 4 | Seismograph / vibration | ✅ built |
| 5 | Audio spectrum analyzer | ✅ built |
| — | Core (mode, diagnostics, calibration, capabilities) | ✅ built |
| — | Magnetic residual probe (§11 q.2 harness) | hidden from the rail — kept for re-testing (§8.7) |
| + | Barcode / QR scanner | ✅ built — beyond the original ten; decodes and describes, never opens |
| + | Pulse (PPG) | ✅ built — beyond the original ten; heart rate only, explicitly not a medical device |
| + | Vizer | ✅ built — beyond the original ten; colour distribution of the scene, ordered as a spectrum |
| 6 | Floor-plane rangefinder | ✅ built and **verified on device** — within inches after two-point calibration |
| 7 | Magnetic anomaly detector | ⛔ built and correct, but no signal exists on iOS 26.6.1 — hidden from the rail |
| 8 | Ultrasonic Doppler | ✅ built and **verified on device** — detects motion and direction |
| 9 | ML depth scanner | ✅ built and **verified on device** — WebGPU, fp16, 252 px |
| 10 | Acoustic sonar | ✅ built and **verified on device** — all three bands, ultrasonic included |

Nothing has been verified on a physical iPhone yet. See
[On-device verification](#on-device-verification).

## Running it

### Desktop

```sh
npm install
npm run dev          # https://localhost:5173
```

`npm run dev` and `npm run build` both first run `scripts/copy-ort.mjs`, which
copies ~63 MB of ONNX Runtime WebAssembly out of `node_modules` into
`public/ort/` for Instrument 9. Those are build artefacts and are gitignored.
Self-hosted rather than fetched from a CDN because the installed runtime is a
dev build whose exact version may not exist on one — and a near-miss version
fails at runtime rather than 404ing somewhere you would notice.

`localhost` is a secure context, so no certificate work is needed. Desktop
Chromium has no DeviceMotion and no `webkitCompassHeading`, so the compass and
seismograph will sit idle — useful for layout, not for signal.

### On the phone (fully local, no tunnel)

iOS requires a **secure context** for motion, orientation, geolocation, camera
and microphone, and a phone cannot use `localhost`. Over plain HTTP the APIs do
not throw — the events simply never fire, which is the single most misleading
failure mode in this project (§6). So the LAN needs real TLS.

This repo does that locally with a private CA. One-time setup:

```sh
npm run certs        # generate the CA + a leaf cert for this machine
npm run serve-ca     # plain-HTTP server so the phone can fetch the CA
```

On the iPhone, open `http://<your-hostname>.local:8000/` and:

1. Tap **Download certificate**.
2. **Settings → General → VPN & Device Management** → the downloaded profile → **Install**.
3. **Settings → General → About → Certificate Trust Settings** → switch on **Tricorder Dev CA**.

Step 3 is the one everyone misses. Installing the profile alone is not enough —
without enabling full trust, Safari still rejects the certificate.

Then stop `serve-ca`, run `npm run dev`, and open `https://<hostname>.local:5173`
on the phone. WKWebView uses the system trust store, so this works identically
in Safari, Chrome and Edge.

`npm run certs` re-signs the leaf for whatever IPs the machine currently holds
and reuses the existing CA, so a DHCP change needs a re-run but **not** a
re-install on the phone.

## Tests

```sh
npm test           # everything
npm run test:unit  # pure logic — no browser, no server, fast
```

`tests/unit/` checks the maths against closed-form answers — ranging geometry,
the sonar matched filter, PPG rate estimation, barcode payload analysis, colour
binning. Those are the suites that caught real errors. `tests/browser/` drives
the real UI, and where a sensor cannot be faked it asserts the *honest failure*
instead: that the instrument says it has no signal rather than inventing one.

A green headless run is a regression net, never evidence about the platform.
The two worst bugs this project has seen were invisible in Chromium and obvious
on the phone. See `tests/README.md`.

## Architecture

```
src/
  sensors/       raw streams, no UI. Refcounted so N instruments share 1 listener.
    stream.ts      SensorStream — starts on first subscriber, stops after the last
    motion.ts      devicemotion → accel / accelG / omega / dt
    orientation.ts deviceorientation → alpha,beta,gamma + webkitCompass*
    gravity.ts     low-passed gravity-down unit vector, pitch, roll
    geo.ts         watchPosition wrapper + fix-quality helpers
    audio.ts       per-profile mic acquisition (NOT a shared stream — see §5)
  instruments/   one screen each; consumes sensors/, owns its own maths
    residual.ts    gyro/compass residual — shared by Instrument 7 and the probe
    camera.ts      getUserMedia video + object-fit-aware tap mapping
  lib/           permissions, capabilities, DSP, vectors, wake lock, storage
  ui/            LCARS shell, screen lifecycle, DOM helpers
```

Two rules the code is built around:

**Screen lifecycle is the core abstraction.** `Instrument` (in `ui/screen.ts`)
registers every subscription, listener, interval and animation frame, and tears
them all down on unmount. Nothing is trusted to remember its own cleanup,
because a leaked camera or mic stream keeps the iOS privacy indicator lit and
reads as spyware.

**There is no global microphone.** Measurement instruments need
`echoCancellation`/`noiseSuppression`/`autoGainControl` all off; a voice meter
wants them on. Those are incompatible, so each screen acquires the profile it
needs and releases it on exit (§5).

## On-device verification

M1 is not done until it has run on real hardware in all three browsers. The
Core screen exists to make this fast — it reports every capability, the
runtime audio sample rate, live event rates, and the gravity calibration state.

Open questions from §11. Targeting iOS 26+ answers 3, 7 and half of 6 by
version, but they are all still worth confirming per browser, because the
WKWebView-versus-Safari question is not a version question:

1. **`accelerationIncludingGravity` sign convention.** Core → *Gravity sign
   convention*, phone flat and screen up. Nothing assumes a polarity at build
   time; the result is persisted and shown. Record the observed vector in the
   comment block at the top of `src/sensors/gravity.ts`. **Still open.**
2. **Whether Core Motion's fusion damps the gyro/compass residual.** The one
   genuinely open technical question in the handoff. **Answered negatively,
   after an earlier positive answer was retracted.** Instrument 7 reaches a
   0.0084° noise floor and fires at 0.067°, and sees nothing from any magnet at
   any distance or angle. Raw `webkitCompassHeading` never moves; Apple's own
   Compass app agrees. Signal A is dead too. A first session recorded 691× the
   noise floor and has never reproduced — see §8.7 of the handoff for the full
   story and four candidate explanations.
3. **Audio sample rate** — **answered: 48000 Hz**, Nyquist 24 kHz, so the full
   15–22 kHz band is usable and neither Instrument 8 nor 10 needs its narrowed
   44.1 kHz variant.
6. **WebGPU exposure** — **answered.** Present in Chrome on iOS 26, so
   WKWebView does expose it and this is not a Safari-only capability.
   Instrument 9 can commit to the WebGPU path; the WASM fallback stays as a
   safety net rather than an expected route. Confirm in Edge when convenient.
7. **Wake Lock** — guaranteed by the floor; the Core row confirms it is
   actually held, which is a different claim.
8. **Motion-prompt behaviour and denial recovery** — exercise the boot gate in
   each browser. **Still open.**

### Device results so far — iPhone, iOS 26.6.1

| Check | Result |
|---|---|
| §11 q.1 gravity sign | **Answered.** Flat screen-up reads (-0.03, 0.21, -9.80) → iOS convention, SIGN = +1 |
| Compass heading | Pass — within 2° of a known-good compass |
| Bubble level | Pass — within 2° of a real spirit level. Validates the pitch/roll axis mapping the rangefinder depends on |
| Seismograph | Pass |
| Geo | Pass |
| Spectrum | Pass, after fixing a dangling AnalyserNode WebKit never fed |
| §11 q.6 WebGPU | **Answered.** Present in **Chrome** on iOS 26 — WKWebView exposes it, not Safari only |
| §11 q.2 residual | **Answered negatively.** An earlier positive result was retracted — no magnetic signal reaches the web layer on iOS 26.6.1 |
| Rangefinder | Pass — uncalibrated it read 1.76 m at 2.00 m (−12%); after two-point calibration, accurate to inches |
| §11 q.3 sample rate | **Answered.** 48000 Hz, Nyquist 24 kHz — full 15–22 kHz ultrasonic band usable |
| Doppler | Pass — detects a hand approaching and receding, direction correct |
| Sonar | Pass — ranges in all three bands, including the specified ultrasonic 15–22 kHz |
| Depth scanner | Pass — live depth map on WebGPU with fp16 at 252 px. Single-shot and continuous both stable past 30 s once the rate was capped at ~5 fps |
| Depth scanner size | **252px 342 ms vs native 518px 2255 ms** — 6.6×. Handing the pipeline a smaller canvas does nothing; the processor's own size is what counts |
| Depth scanner dtype | **fp16 500 ms, q4f16 1000 ms, q8 3600 ms** on WebGPU at 256px. §8.9's recommended q8 is 7.2× slower than fp16, and slower than the CPU path |
| §11 q.4 lux meter | **Answered: no.** Neither `exposureTime` nor `iso` is exposed in any browser, so only a *relative* light meter is possible. `torch` and `zoom` **are** exposed |

**Verified in Safari, Chrome and Edge** on iOS 26.6.1 — everything built works in all three, and no browser-specific code path exists or turned out to be needed. That satisfies the §10 M1 gate.

Acceptance tests per §8, in build order:

- **Compass** — reads within ~5° of a known-good compass; the bubble agrees with
  a real spirit level on a flat table. Cheapest test of the orientation
  permission path, so run it first in all three browsers.
- **Rangefinder** — calibrate first, then objects at a tape-measured 1 m, 2 m
  and 4 m read within 10%. Use the **two-point** calibration: a single known
  distance cannot separate field of view from camera height, so a one-point fit
  reads perfectly at its own calibration distance and wrongly everywhere else.
  Frame the first target low in the frame and the second nearer the middle,
  keeping the phone at a similar tilt — the field-of-view information comes
  from where the taps fall in the frame, not from how far away the targets are.
  The fit measures its own conditioning and refuses anything no better than
  the uncalibrated guess.
- **Seismograph** — tapping the table makes clear transients; a phone sitting
  still reads near zero.
- **Spectrum** — play a 440 Hz tone from another device; the peak lands within
  one bin (2.93 Hz at a 48 kHz sample rate).
- **Geo** — walk 100 m; the logged distance lands within ~10%.

## Deliberate non-goals

Absolute SPL in dB, Richter magnitude, metric depth from the ML model,
barometric pressure, temperature, humidity, radiation, NFC and battery. Either
no API exists on iOS in any browser, or the phone cannot be calibrated for it.
They are not faked, and Core lists the absent APIs explicitly so a future
reader does not go hunting.

## Licence

[MIT](LICENSE). Use it, change it, ship it commercially — the one condition is
that the copyright notice and licence text travel with it. No warranty, and the
authors carry no liability.

The dependencies it ships are all permissive too — Apache 2.0 (Transformers.js,
zxing-wasm, Depth Anything V2), MIT (ONNX Runtime Web) — and Antonio is under
the SIL Open Font License. The eight colour schemes in Core → Mode are sampled
from CupcakeEternity's *Starfleet LCARS Colour Schemes · 25th Century* (2021);
that credit is not optional and is rendered in the app itself, not only here.

LCARS is a Star Trek design language and Star Trek is a Paramount property.
This is a fan-made homage with no affiliation or endorsement, which the MIT
grant above does not and cannot extend to.
