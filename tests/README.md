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


## The suite was never flaky

For a while a full run dropped one suite per pass, and it was a *different*
suite each time — the signature of contention, so that is what it was assumed
to be. It was not.

The runner only printed lines matching `FAIL|ERROR`, so a suite that died at
the process level — a throw, a timeout, a browser that would not launch —
printed a `FAIL` header and then nothing at all. With no evidence to read, the
failure looked random. The runner now prints the exit code and the tail of the
output whenever a suite fails without producing a FAIL line, and the cause was
legible immediately:

- **`waiting for locator('.engage')`.** The boot gate is the first interaction
  in every suite and waits on a full page load. Playwright's 30 s default
  action timeout had never been stated as a budget for that, and on a loaded
  machine it is not one. Every browser suite now sets `setDefaultTimeout`
  explicitly.
- **`waiting for … "Inference"`.** Depth loads an ONNX model and compiles it
  for WebGPU, and every suite gets a fresh browser profile, so that cost is
  paid again each pass against a cold HTTP cache. The four depth-touching
  suites budget 120 s.

Both were missing timeouts, not resource limits. Three consecutive full runs
pass at 21/21.

**If a suite fails, read the indented lines under it before re-running.** The
temptation to shrug and re-run is exactly what kept this hidden.


## Known: one suite per full run can still fail at the boot gate

A full run occasionally drops a single suite at
`waiting for locator('.engage')`, and it is a *different* suite each time. It
always passes when run on its own.

Two real causes have been found and fixed — unstated timeouts, and
`waitUntil: 'networkidle'`, which Playwright discourages and which this app
never reliably reaches because it holds an HMR socket. Neither eliminated it
entirely.

The remaining suspect is the **dev server itself**: twenty-four suites each
launch a browser against one Vite instance, and Vite's dependency
re-optimisation stalls requests when the module graph changes — which it does
constantly while developing. The obvious fix is to run the browser suites
against `vite preview` (static files, no transform pipeline) instead of `vite`.
That is a real change rather than a workaround, since `tests/README` already
notes dev and production differ for the ONNX glue, and it has **not** been done
yet.

**If a suite fails, run it on its own before believing it.** And read the
indented lines under the failure — the runner prints the exit code and output
tail precisely so this does not have to be guesswork.
