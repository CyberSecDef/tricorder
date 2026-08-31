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

## Status — M1 complete

| # | Instrument | State |
|---|---|---|
| 1 | Permission / boot gate | ✅ built |
| 2 | Geo & navigation | ✅ built |
| 3 | Compass / attitude | ✅ built |
| 4 | Seismograph / vibration | ✅ built |
| 5 | Audio spectrum analyzer | ✅ built |
| — | Diagnostics | ✅ built |
| 6 | Floor-plane rangefinder | M2 — stub with spec + blockers |
| 7 | Magnetic anomaly detector | M2 — stub |
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
2. **Whether Core Motion's fusion damps the gyro/compass residual** enough to
   kill Instrument 7's signal B. The one genuinely open technical question in
   the handoff, and the gate on M2. **Still open — measure before building.**
3. **Audio sample rate** — Diagnostics → Runtime. Expect 48 kHz on iOS 26,
   giving a 22 kHz ultrasonic ceiling. Confirm rather than assume.
6. **WebGPU exposure** — Safari 26 has it on by default. Whether WKWebView
   exposes it to Chrome and Edge at the same OS version is **still open** and
   decides Instrument 9's backend.
7. **Wake Lock** — guaranteed by the floor; the Diagnostics row confirms it is
   actually held, which is a different claim.
8. **Motion-prompt behaviour and denial recovery** — exercise the boot gate in
   each browser. **Still open.**

### Device results so far — iPhone, iOS 26.6.1

| Check | Result |
|---|---|
| §11 q.1 gravity sign | **Answered.** Flat screen-up reads (-0.03, 0.21, -9.80) → iOS convention, SIGN = +1 |
| Compass accuracy | Pass |
| Seismograph | Pass |
| Geo | Pass |
| Spectrum | **Failed** — dangling AnalyserNode was never fed by WebKit. Fixed; re-verify |
| WebGPU | Present (confirm per browser for §11 q.6) |

Acceptance tests per §8, in build order:

- **Compass** — reads within ~5° of a known-good compass; the bubble agrees with
  a real spirit level on a flat table. Cheapest test of the orientation
  permission path, so run it first in all three browsers.
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
