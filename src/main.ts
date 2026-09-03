import './ui/lcars.css';

import { App, type NavEntry } from './ui/app';
import { bootGate } from './ui/boot';
import { initTheme } from './ui/theme';
import { GeoInstrument } from './instruments/geo';
import { CompassInstrument } from './instruments/compass';
import { SeismographInstrument } from './instruments/seismograph';
import { SpectrumInstrument } from './instruments/spectrum';
import { CoreInstrument } from './instruments/core';
import { RangefinderInstrument } from './instruments/rangefinder';
import { DopplerInstrument } from './instruments/doppler';
import { DepthInstrument } from './instruments/depth';
import { SonarInstrument } from './instruments/sonar';
import { ScannerInstrument } from './instruments/scanner';
import { PulseInstrument } from './instruments/pulse';
import { VizerInstrument } from './instruments/vizer';
import { PLANNED, PlannedInstrument } from './instruments/planned';

const NAV: NavEntry[] = [
  { id: 'geo',      short: 'Geo',      milestone: 'M1', create: () => new GeoInstrument() },
  { id: 'compass',  short: 'Compass',  milestone: 'M1', create: () => new CompassInstrument() },
  { id: 'seismo',   short: 'Seismo',   milestone: 'M1', create: () => new SeismographInstrument() },
  { id: 'spectrum', short: 'Spectrum', milestone: 'M1', create: () => new SpectrumInstrument() },
  { id: 'rangefinder', short: 'Range', milestone: 'M2', create: () => new RangefinderInstrument() },
  { id: 'doppler', short: 'Doppler', milestone: 'M3', create: () => new DopplerInstrument() },
  { id: 'depth', short: 'Depth', milestone: 'M4', create: () => new DepthInstrument() },
  { id: 'sonar', short: 'Sonar', milestone: 'M5', create: () => new SonarInstrument() },
  { id: 'scanner', short: 'Scan', milestone: '+', create: () => new ScannerInstrument() },
  { id: 'pulse', short: 'Pulse', milestone: '+', create: () => new PulseInstrument() },
  { id: 'vizer', short: 'Vizer', milestone: '+', create: () => new VizerInstrument() },
  // Instrument 7 is deliberately absent: it is built and correct, but no
  // magnetic signal reaches the web layer on iOS 26.6.1, so it would be a
  // detector that detects nothing (§8.7 of the handoff). Re-enable by
  // importing MagneticInstrument and restoring its entry here.
  ...PLANNED.filter((p) => p.id !== 'rangefinder' && p.id !== 'magnetic' && p.id !== 'doppler' && p.id !== 'depth' && p.id !== 'sonar').map((p) => ({
    id: p.id,
    short: p.short,
    milestone: p.milestone,
    create: () => new PlannedInstrument(p),
  })),
  { id: 'core',     short: 'Core',     milestone: 'M1', create: () => new CoreInstrument() },
];

async function start(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app missing');

  // Before the boot gate, so the gate itself is painted in the saved scheme
  // rather than flashing Standard and then correcting itself.
  initTheme();

  // Nothing mounts until the single-gesture unlock has run (§4).
  await bootGate();

  new App(NAV).mount(root);
}

void start();
