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
tests/         unit/ (pure logic), browser/ (end to end), retired/ (suites for
               instruments no longer in the rail). See tests/README.md
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

Full LCARS. Geometry lives in `src/ui/lcars.css` — `--rail-w`, `--bar-h`,
`--elbow-h`, `--elbow-ext`, `--elbow-r`, `--inner-r`. The elbow geometry is
load-bearing: the stem is exactly one rail wide so it lines up with the buttons
beneath it, and the arm is exactly one bar tall so it reads as continuous with
the header.

**The rail has a height budget.** Thirteen entries already fill a phone. Adding
an instrument adds a button, and nothing else in the app notices — `smoke.test.mjs`
asserts the stack still fits 390×640 and that no label wraps. If it fails, lower
`--rail-btn-h` (currently 36px on phones, 46px at ≥620px); do **not** reach for
the font size first. The type needs about 34px and the button floor is what
actually binds, so shrinking type alone changes nothing.

**Colour is theme data, not CSS.** Eight schemes live in `src/ui/palette.ts`;
`src/ui/theme.ts` generates the per-mode custom-property blocks *from* them and
injects one `<style>`. Never hard-code a colour:

- **In CSS**, use a role token — `--frame`, `--dark1/2`, `--light1/2`,
  `--active`, `--rail-1..4`, `--text`, `--grid`, `--grid-mid`. Never a pigment
  and never a literal. `lcars.css` carries the Standard values on bare `:root`
  purely as the pre-JS first paint.
- **In canvas code**, `const col = theme();` then `col.light1`, `col.grid`,
  `col.trace[n]`, `alpha(col.frame, 0.6)`. `theme()` is a field read, so
  calling it per frame is free. Anything that *caches* colour (a gradient, an
  ImageData, an offscreen canvas) must also subscribe via `onThemeChange`.
- **Text on a coloured ground** takes `ink(bg, text)` — or `--rail-N-ink` in
  CSS — never a fixed black. Standard's rail swatches are all light so black
  worked; Red and Blue Alert have near-black swatches where it does not.

Three carve-outs, all deliberate, all asserted by tests:

1. **`--ok` / `--warn` / `--bad` never change with the mode.** Red Alert would
   otherwise draw all three states in the same red, and every readout here is a
   measurement whose state must be readable at a glance.
2. **Vizer's spectrum and `lib/huespectrum.ts` are never themed.** Those
   colours *are* the measurement — they are the hues present in the camera
   feed. `tests/browser/mode.test.mjs` asserts its hue histogram does *not*
   move when the mode does.
3. **Surfaces stay black in every scheme.** An LCARS alert mode recolours the
   elements, not the ground.
