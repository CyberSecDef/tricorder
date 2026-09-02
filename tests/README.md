# Tests

No framework. Each file prints `PASS` / `FAIL` lines and exits non-zero on
failure; `run.mjs` collects them. That is deliberate — most of the value here
is in assertions that check a number against a closed-form answer, and those
are worth reading directly rather than through a matcher.

```sh
node tests/run.mjs unit       # pure logic — no browser, no server
node tests/run.mjs browser    # needs a dev server running
node tests/run.mjs            # both
```

## `unit/` — pure logic

No browser, no camera, no network. These are the ones that caught real errors,
because they check maths against answers worked out independently.

| Suite | Covers |
|---|---|
| `geom` | Floor-plane ranging (§8.6). 30° depression gives `h·√3`, above the horizon returns null, a synthesised tap round-trips through the FOV solver, and a single-point fit with a wrong height is shown to be exact at its own calibration distance and 10.6% out elsewhere — the degeneracy two-point calibration exists to remove. |
| `sonar-dsp` | Matched filter (§8.10). Sub-millimetre recovery at 0.5–5 m against a full-strength direct-path leak, including a 1% echo, plus the prominence gate that separates a real return (12–40 000×) from a bare leak skirt (3.1×). |
| `pulse` | PPG rate estimation (§15). 45–200 bpm recovered to a few tenths from a synthetic pulse with a dicrotic notch, 1% modulation, drift and noise. Pure noise must score low enough to be rejected. |
| `payload` | Barcode payload analysis (§14). Classification, plus every hazard the scanner is meant to name: `javascript:`/`data:`/`file:`, punycode hosts, embedded credentials, raw IPs, open Wi-Fi, and each class of invisible character. |
| `hue` | Vizer colour binning (§16). Single colours land on the right hue, a blue scene contains *exactly zero* red, greys and near-blacks are excluded rather than smeared, magenta is classified non-spectral. |

## `retired/` — not run by default

Suites for the magnetic anomaly detector and its probe. Both instruments are
still in the tree, neither is in the rail (§8.7), so these click a button that
no longer exists and time out. Kept because they are the apparatus that would
prove a future device behaves differently. See `retired/README.md`.

## `browser/` — end to end

Need `playwright-core` and a running server. They drive the real UI, and where
a sensor cannot be faked they assert the *honest failure* instead — that the
instrument says it has no signal rather than inventing one.

```sh
npm run dev            # or: npx vite preview   (see below)
node tests/run.mjs browser
```

`TRICORDER_URL` overrides the target — use `https://localhost:4173/` to test a
production build via `vite preview`, which is worth doing for anything touching
the ONNX runtime, because the dev server and a static host genuinely differ
there (§8.9).

`CHROME_PATH` overrides the browser binary; it defaults to the playwright
chromium under `~/.cache/ms-playwright/`.

**What headless cannot cover, and why some of these assert failure:** there is
no acoustic path from speaker to microphone, no real camera, no GPU adapter,
and no magnetometer. So `sonar` asserts that a missing return is reported as
one, `pulse-ui` asserts the finger check rejects the test pattern, and `dop`
asserts the mute-switch path fires. A green run here is a regression net, never
evidence about the platform — the two worst bugs this project has seen were
invisible in Chromium and obvious on the phone.
