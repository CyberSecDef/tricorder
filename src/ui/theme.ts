/**
 * Theme engine (§18).
 *
 * Two consumers have to agree on one palette: CSS (chrome, rail, panels) and
 * canvas 2D (every trace, grid and axis in every instrument). They cannot
 * share a `var()`, so the palette lives here in TypeScript and CSS is
 * *generated* from it into a single <style> element. That is the opposite of
 * the usual arrangement, and it is deliberate: the alternative — canvases
 * calling getComputedStyle() to read custom properties back out — parses
 * strings, depends on layout timing, and silently yields '' during the first
 * paint after a mode change. Generating one direction only means there is
 * exactly one source of truth and no parsing anywhere.
 *
 * `lcars.css` is authored entirely against the role tokens this emits. It
 * carries the Standard palette inline on :root as a no-JS fallback so the
 * first paint is never unstyled.
 */

import { SCHEMES, RAIL_ROTATION, DEFAULT_MODE, schemeOf, isModeId,
         type ModeId, type Palette, type Role } from './palette';

const STORAGE_KEY = 'tricorder.mode';
const STYLE_ID = 'lcars-theme';

/* ---------- colour maths ------------------------------------------------ */

const hex = (h: string): [number, number, number] => {
  const v = h.replace('#', '');
  const n = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
};

const toHex = (r: number, g: number, b: number): string =>
  '#' + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');

/** Linear blend. t=0 returns a, t=1 returns b. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** `#rrggbb` + 0..1 opacity → `#rrggbbaa`. Canvas takes this directly. */
export function alpha(c: string, a: number): string {
  const v = Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
  return c.slice(0, 7) + v;
}

/** WCAG relative luminance. */
export function luminance(c: string): number {
  const [r, g, b] = hex(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pick the more legible foreground for a given background.
 *
 * This exists because the rail buttons are painted in four different scheme
 * colours and always drew their label in black. That is correct for Standard,
 * whose four rail colours are all light — and unreadable in Red Alert and Blue
 * Alert, whose `dark1`/`dark2` are near-black already. Choosing per swatch is
 * the only thing that works across eight palettes.
 */
export function ink(bg: string, light: string): string {
  // Prefer the scheme's own text colour whenever it is comfortably legible —
  // that keeps the rail on-palette. Mid-luminance swatches (Blue's #2a2aff,
  // Red's #aa0000, Grey's #6c5368) clear neither black nor the scheme text at
  // 4.5:1, so those fall back to whichever pole is further away. Without white
  // as a candidate there is no legible answer for them at all.
  if (contrast(bg, light) >= 5) return light;
  return contrast(bg, '#000000') >= contrast(bg, '#ffffff') ? '#000000' : '#ffffff';
}

/** WCAG contrast ratio between two colours, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ---------- derived colours --------------------------------------------- */

/**
 * Semantic state colours do NOT change with the mode, and that is a considered
 * decision rather than an oversight.
 *
 * LCARS canon says an alert scheme recolours the entire console, and following
 * that literally would make Red Alert render "good", "caution" and "failure"
 * in three shades of the same red. Every readout in this app is a measurement
 * whose state the user is supposed to be able to read at a glance (§9); a
 * theme that makes 'ok' and 'bad' hard to tell apart trades a real property of
 * the instrument for a decorative one. The chrome takes the alert colour; the
 * three state colours stay put.
 */
export const OK = '#66cc88';
export const WARN = '#ffcc00';
export const BAD = '#ff5555';

/** Everything canvas code needs. Derived once per mode change, never parsed. */
export interface Colors extends Palette {
  /** Plot background — a hair lighter than page black, tinted by the frame. */
  plot: string;
  /** Faint gridlines. */
  grid: string;
  /** Emphasised gridlines and axes. */
  gridMid: string;
  /** Dim annotation text on canvas. */
  dim: string;
  /** Dimmer still — units, ghost labels. */
  dimmer: string;
  /** Four perceptually-ordered series colours for multi-trace plots. */
  trace: readonly [string, string, string, string];
  ok: string;
  warn: string;
  bad: string;
}

/*
 * Surfaces stay black in every scheme, and this is canon rather than laziness:
 * an LCARS alert mode recolours the *elements*, never the ground they sit on.
 * It also keeps Standard byte-identical to the palette this app already had,
 * whose panels were a neutral blue-black that no amount of tinting toward
 * Butterscotch would reproduce.
 */
export const PANEL = '#14141c';
export const SURFACE = '#06060a';

function derive(p: Palette): Colors {
  const BG = '#000000';
  return {
    ...p,
    plot:    mix(BG, p.frame, 0.06),
    grid:    mix(BG, p.frame, 0.14),
    gridMid: mix(BG, p.frame, 0.28),
    dim:     mix(p.text, BG, 0.42),
    dimmer:  mix(p.text, BG, 0.62),
    // Ordered light → dark so the series stay distinguishable by luminance
    // even in the schemes (Red, Blue, Grey) that have almost no hue spread.
    trace:   [p.light1, p.light2, p.dark1, p.active],
    ok: OK, warn: WARN, bad: BAD,
  };
}

/* ---------- CSS emission ------------------------------------------------ */

/** The role tokens `lcars.css` is written against, for one scheme. */
export function cssFor(p: Palette, selector: string): string {
  const c = derive(p);
  const rail = RAIL_ROTATION.map((r: Role, i) =>
    `  --rail-${i + 1}: ${p[r]};\n  --rail-${i + 1}-ink: ${ink(p[r], p.text)};`).join('\n');
  return `${selector} {
  --disabled: ${p.disabled};
  --dark1: ${p.dark1};
  --dark2: ${p.dark2};
  --frame: ${p.frame};
  --light1: ${p.light1};
  --light2: ${p.light2};
  --active: ${p.active};
  --active-ink: ${ink(p.active, p.text)};
  --frame-ink: ${ink(p.frame, p.text)};
  --text: ${p.text};
${rail}
  --text-dim: ${c.dim};
  --text-dimmer: ${c.dimmer};
  --grid: ${c.grid};
  --grid-mid: ${c.gridMid};
  --ok: ${c.ok};
  --warn: ${c.warn};
  --bad: ${c.bad};
}`;
}

export const allCss = (): string =>
  SCHEMES.map((s) => cssFor(s.palette, `:root[data-mode="${s.id}"]`)).join('\n');

/* ---------- state ------------------------------------------------------- */

let current: ModeId = DEFAULT_MODE;
let colors: Colors = derive(schemeOf(DEFAULT_MODE).palette);
const listeners = new Set<(c: Colors, m: ModeId) => void>();

/** The active palette. Canvas code calls this every frame; it is a field read. */
export const theme = (): Colors => colors;
export const mode = (): ModeId => current;

/**
 * Subscribe to mode changes. Returns an unsubscribe. Instruments that cache
 * anything colour-derived (gradients, ImageData, offscreen canvases) must use
 * this — a plain `theme()` read per frame is enough for everything else.
 */
export function onThemeChange(fn: (c: Colors, m: ModeId) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setMode(id: ModeId): void {
  if (!isModeId(id)) return;
  current = id;
  colors = derive(schemeOf(id).palette);
  document.documentElement.dataset.mode = id;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private mode — theme just won't persist */ }
  for (const fn of listeners) fn(colors, id);
}

/** Injects the generated stylesheet and restores the persisted mode. */
export function initTheme(): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = allCss();
    document.head.appendChild(style);
  }
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  setMode(isModeId(saved) ? saved : DEFAULT_MODE);
}
