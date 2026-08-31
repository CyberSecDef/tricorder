# Tricorder

A browser-based sensor suite for **iOS 26+** — Safari, Chrome and Edge. Every
readout comes from a real device measurement, and anything derived or
uncalibrated says so in the UI.

**Target:** iOS 26 or later. Reference device: iPhone on iOS 26.6.1.
That floor clears every version gate the handoff hedged against — Wake Lock
(16.4+), WebGPU (Safari 26+), AudioWorklet (14.5+), getUserMedia in WKWebView
(14.3+). Feature detection stays regardless: the reason to detect is that
Chrome and Edge on iOS are WKWebView, and what an embedded web view exposes is
not guaranteed to match Safari at the same OS version. Diagnostics flags any
divergence from the floor as a finding rather than shrugging at it.

Implementation constraints, instrument specs and the open questions live in
[`TRICORDER_HANDOFF.md`](TRICORDER_HANDOFF.md). Section references throughout
the source point back at it.

## Status — M1 complete, M2 built

| # | Instrument | State |
|---|---|---|
| 1 | Permission / boot gate | ✅ built |
| 2 | Geo & navigation | ✅ built |
| 3 | Compass / attitude | ✅ built |
| 4 | Seismograph / vibration | ✅ built |
| 5 | Audio spectrum analyzer | ✅ built |
| — | Diagnostics | ✅ built |
| — | Magnetic residual probe (§11 q.2 harness) | ✅ built — awaiting a magnet sweep |
| 6 | Floor-plane rangefinder | ✅ built — needs tape-measure verification |
| 7 | Magnetic anomaly detector | ✅ built — needs on-device verification |
| 8 | Ultrasonic Doppler | M3 — stub |
| 9 | ML depth scanner | M4 — stub |
| 10 | Acoustic sonar | M5 — stub |

Nothing has been verified on a physical iPhone yet. See
[On-device verification](#on-device-verification).

## Running it

### Desktop

```sh
npm install
npm run dev          # https://localhost:5173
```

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
Diagnostics screen exists to make this fast — it reports every capability, the
runtime audio sample rate, live event rates, and the gravity calibration state.

Open questions from §11. Targeting iOS 26+ answers 3, 7 and half of 6 by
version, but they are all still worth confirming per browser, because the
WKWebView-versus-Safari question is not a version question:

1. **`accelerationIncludingGravity` sign convention.** Diagnostics → *Calibrate
   gravity*, phone flat and screen up. Nothing assumes a polarity at build
   time; the result is persisted and shown. Record the observed vector in the
   comment block at the top of `src/sensors/gravity.ts`. **Still open.**
2. **Whether Core Motion's fusion damps the gyro/compass residual.** The one
   genuinely open technical question in the handoff. **Answered: it does not.**
   Measured with the probe screen on iOS 26.6.1, static protocol:

   | | baseline | disturbed |
   |---|---|---|
   | rotation | 0.85° | 9.18° |
   | residual RMS | **0.021°** | 4.68° |
   | residual peak | 0.216° | **14.28°** |
   | compass accuracy | 10° | 10° → 26° |

   Signal B reaches **691× its noise floor** against a threshold of 4×.
   Signal A responds too but weakly and late, lagging the residual by seconds.
   Instrument 7 is buildable, on B primarily and A as corroboration.
3. **Audio sample rate** — Diagnostics → Runtime. Expect 48 kHz on iOS 26,
   giving a 22 kHz ultrasonic ceiling. Confirm rather than assume.
6. **WebGPU exposure** — **answered.** Present in Chrome on iOS 26, so
   WKWebView does expose it and this is not a Safari-only capability.
   Instrument 9 can commit to the WebGPU path; the WASM fallback stays as a
   safety net rather than an expected route. Confirm in Edge when convenient.
7. **Wake Lock** — guaranteed by the floor; the Diagnostics row confirms it is
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

Tested in Chrome. Safari and Edge still outstanding for the §10 M1 gate.

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
They are not faked, and Diagnostics lists the absent APIs explicitly so a future
reader does not go hunting.
