import './ui/lcars.css';

import { App, type NavEntry } from './ui/app';
import { bootGate } from './ui/boot';
import { GeoInstrument } from './instruments/geo';
import { CompassInstrument } from './instruments/compass';
import { SeismographInstrument } from './instruments/seismograph';
import { SpectrumInstrument } from './instruments/spectrum';
import { DiagnosticsInstrument } from './instruments/diagnostics';
import { MagProbeInstrument } from './instruments/magprobe';
import { RangefinderInstrument } from './instruments/rangefinder';
import { PLANNED, PlannedInstrument } from './instruments/planned';

const NAV: NavEntry[] = [
  { id: 'geo',      short: 'Geo',      milestone: 'M1', create: () => new GeoInstrument() },
  { id: 'compass',  short: 'Compass',  milestone: 'M1', create: () => new CompassInstrument() },
  { id: 'seismo',   short: 'Seismo',   milestone: 'M1', create: () => new SeismographInstrument() },
  { id: 'spectrum', short: 'Spectrum', milestone: 'M1', create: () => new SpectrumInstrument() },
  { id: 'rangefinder', short: 'Range', milestone: 'M2', create: () => new RangefinderInstrument() },
  ...PLANNED.filter((p) => p.id !== 'rangefinder').flatMap((p) => [
    // The residual probe sits immediately before the instrument it gates, so
    // the dependency is visible in the rail rather than only in the docs.
    ...(p.id === 'magnetic'
      ? [{ id: 'magprobe', short: 'Probe', milestone: 'q.2', create: () => new MagProbeInstrument() }]
      : []),
    {
      id: p.id,
      short: p.short,
      milestone: p.milestone,
      create: () => new PlannedInstrument(p),
    },
  ]),
  { id: 'diag',     short: 'Diag',     milestone: 'M1', create: () => new DiagnosticsInstrument() },
];

async function start(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing');

  // Nothing mounts until the single-gesture unlock has run (§4).
  await bootGate();

  new App(NAV).mount(root);
}

void start();
