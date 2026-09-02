# Tricorder — working notes

A browser-based sensor suite for **iOS 26+**, in Safari, Chrome and Edge.
Thirteen instruments. Vite + TypeScript, vanilla DOM, no UI framework, no
runtime dependencies except the two WASM decoders.

`TRICORDER_HANDOFF.md` is the specification and the record. It began as
predictions written before anything existed and has been updated from
measurements throughout: findings are marked **MEASURED**, and predictions that
turned out wrong are marked **CORRECTION** with the original reasoning kept.
**Read §13 first** — it says where to pick up. When you learn something on
device, record it there in the same form.

## The rule that shapes everything

**Every readout is a real measurement, and anything derived, uncalibrated or
estimated says so in the UI.** This is not a style preference; it is the point
of the project, and it has repeatedly changed what got built:

- Instrument 7 is correct, sensitive to 0.067°, and **hidden from the rail**,
  because no magnetic signal reaches the web layer on iOS 26. Shipping a
  detector that detects nothing was not an option (§8.7).
- The sonar refuses to report unless independent pings agree *and* the peak
  rises above its own neighbourhood — consistent nonsense is harder to catch
  than inconsistent nonsense (§8.10).
- The pulse instrument reports rate only, and says plainly that it cannot do
  SpO2, blood pressure or arrhythmia (§15).
- The scanner never creates a link, and a test asserts the screen contains zero
  anchors — "we did not mean to make it clickable" is not a guarantee (§14).

When an instrument cannot produce a trustworthy number, say which failure it
is and what the user should do. `src/instruments/magnetic.ts` has the pattern:
a ladder of distinct states, each naming its own remedy.

## Layout of the code

```
src/
  sensors/     raw streams, no UI. Refcounted: N instruments, one listener.
  instruments/ one screen each; consumes sensors/, owns its own maths
  lib/         maths and platform helpers, deliberately DOM-free so they can
               be tested — rangefinder, dsp, pulse, huespectrum, payload
  ui/          screen.ts (lifecycle), app.ts (shell), dom.ts, lcars.css
tests/         unit/ (pure logic) and browser/ (end to end). See tests/README.md
scripts/       cert generation, WASM copy steps
```

**Put the maths in `lib/`, not in the instrument.** Every module there is
covered by a unit test that checks numbers against closed-form answers, and
those tests have caught real errors that would have shown up on a phone as
"the readings look a bit off".

## Two invariants

**Screen lifecycle.** `Instrument` in `ui/screen.ts` registers every
subscription, listener, interval and animation frame and tears them down on
unmount. Never manage those by hand — a leaked camera or mic stream keeps the
iOS privacy indicator lit and reads as spyware.

**No global microphone.** Measurement instruments need the `raw` profile with
all voice DSP off; a level meter wants it on. Those are incompatible, so each
screen acquires the profile it needs and releases it on exit (§5).

## Things that will bite you

- **WebKit only pulls an audio graph that reaches the destination.** A dangling
  `AnalyserNode` returns `-Infinity` forever, silently. Chromium does not
  reproduce it. Terminate through a zero-gain node (§0.7).
- **`AudioContext.currentTime` is a scheduling clock, not an acoustic one.**
  ~240 ms of output+input latency was measured. Never measure time-of-flight
  from it; reference the direct path instead (§8.10).
- **A green headless run is not evidence about the platform.** The two worst
  bugs here were invisible in Chromium and obvious on the phone.
- **One good measurement is not a result.** A single unreproduced magnetometer
  reading briefly became a settled fact in the handoff. Anything gating a build
  decision gets reproduced on a separate occasion (§10).

## Running it

```sh
npm run certs      # once: local CA + leaf for this machine
npm run serve-ca   # once: phone installs the CA over plain HTTP, port 8000
npm run dev        # https://<hostname>.local:5173
npm run build && npx vite preview   # production bundle on :4173
npm test           # unit + browser
```

iOS needs a secure context for every sensor here and cannot use `localhost`, so
LAN development needs a genuinely trusted certificate. Installing the profile
on the phone is not enough — **Settings → General → About → Certificate Trust
Settings** has to be switched on too, and that is the step everyone misses.

`npm run dev` and `npm run build` first copy ~63 MB of WASM out of
`node_modules` into `public/`. Those are gitignored build artefacts.

## Aesthetics

Full LCARS. The design system is `src/ui/lcars.css`, driven by custom
properties at the top — `--rail-w`, `--bar-h`, `--elbow-h`, `--elbow-ext`,
`--elbow-r`, `--inner-r` and the swatch palette. The elbow geometry is
load-bearing: the stem is exactly one rail wide so it lines up with the buttons
beneath it, and the arm is exactly one bar tall so it reads as continuous with
the header.

**Instrument canvases still hard-code their colours** rather than reading the
tokens. A palette change will not reach the traces and scopes until that is
fixed; it is the obvious next move for any serious re-skin.
