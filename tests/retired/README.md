# Retired suites

These test the **magnetic anomaly detector** and the **residual probe** that
answered §11 q.2. Both instruments are still in the source tree and still
compile, but neither is in the navigation rail — there is no magnetic signal to
detect on iOS 26, so shipping the instrument would have meant shipping a
detector that detects nothing (§8.7 of the handoff).

That makes these tests unrunnable rather than broken: they click a rail button
that no longer exists, and time out. The runner therefore skips this directory.

They are kept, not deleted, for the same reason the instruments are: if a
future device or iOS release behaves differently, this is the apparatus that
proves it, and it is already written and already validated. The probe's own
harness was verified against synthetic ground truth — a 15° static heading step
produces a 15.00° raw residual — so it can be trusted as a measuring tool the
moment there is anything to measure.

**To run them:** re-add the two instruments to the rail in `src/main.ts`
(import `MagneticInstrument` and `MagProbeInstrument`, restore their `NAV`
entries), then:

```sh
node tests/retired/gate2.test.mjs
```

`static.test.mjs` is the one to start with — it drives a synthetic heading step
and proves the residual maths still works end to end, independent of whether
any real field reaches the sensor.
