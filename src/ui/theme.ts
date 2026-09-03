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
 * Lift a colour until it is legible as TEXT on a dark ground, whitening as
 * little as possible to get there.
 *
 * Needed because the chart's roles are fills, not type. `frame` is literally
 * "Frame / Shoulder Colour" — the elbow and the header bar — and using it for
 * section headings worked only because Standard's Butterscotch happens to be
 * bright. Blue Alert's frame is #0000d4, which sits at 1.95:1 on black and is
 * effectively invisible.
 *
 * Whitening rather than raising HSL lightness is not a stylistic choice: blue
 * contributes just 0.0722 to relative luminance, so even a fully saturated
 * #0000ff only reaches 2.44:1. No amount of lightening a pure blue clears 4.5
 * — desaturating toward white is the only way to get there, and the binary
 * search keeps as much of the hue as the threshold allows.
 */
/*
 * 6.5:1, not the WCAG AA floor of 4.5. This is an aesthetic threshold sitting
 * above the legibility one: at 4.5 Blue Alert's headings are *readable* and
 * still look dim next to Yellow's 13.8. 6.5 is the highest floor that fixes
 * the dark schemes without disturbing the ones that were already right —
 * Standard, Maintenance, Teal and Yellow pass through untouched, and at 7.5
 * Maintenance starts shifting for no reason.
 */
export const TEXT_MIN = 6.5;

export function onDark(c: string, min = TEXT_MIN, bg = '#000000'): string {
  if (contrast(c, bg) >= min) return c;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const t = (lo + hi) / 2;
    if (contrast(mix(c, '#ffffff', t), bg) >= min) hi = t; else lo = t;
  }
  return mix(c, '#ffffff', hi);
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

/** CIE L*a*b*, D65. */
export function lab(c: string): [number, number, number] {
  const [r, g, b] = hex(c).map((v) => {
    const u = v / 255;
    return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
  });
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * CIE76 colour difference. This — not `contrast` — is the right measure of
 * "can a person tell these two apart": contrast is a ratio of luminances and
 * reports any two equally-bright colours as identical regardless of hue.
 * Roughly: 2.3 is just noticeable, 25+ is obviously a different colour.
 */
export function deltaE(a: string, b: string): number {
  const [la, aa, ba] = lab(a), [lb, ab, bb] = lab(b);
  return Math.hypot(la - lb, aa - ab, ba - bb);
}

/**
 * Choose four maximally-separated series colours from the scheme.
 *
 * Picking four roles by name does not work. Grey Mode aliases `light2` to
 * `light1` (the chart gives it five swatches, not seven), so a fixed
 * [light1, light2, …] ramp hands the seismograph the SAME colour for its X and
 * Y traces — two axes that are impossible to tell apart, which is exactly the
 * kind of silently-wrong readout this project is supposed to refuse.
 *
 * So: lift every candidate role to the legibility floor, drop duplicates, and
 * pick the 4-subset with the largest minimum pairwise ΔE. Fifteen combinations
 * at most, evaluated once per mode change.
 */
export function traceRamp(p: Palette): [string, string, string, string] {
  const cands = [...new Set(
    ([p.light1, p.light2, p.active, p.frame, p.dark1, p.dark2]).map((c) => onDark(c, 4.5)),
  )];
  while (cands.length < 4) cands.push(mix(cands[cands.length - 1] ?? '#ffffff', '#ffffff', 0.35));

  let best = cands.slice(0, 4), bestScore = -1;
  const n = cands.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++)
    for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
      const pick = [cands[a], cands[b], cands[c], cands[d]];
      let worst = Infinity;
      for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++)
        worst = Math.min(worst, deltaE(pick[i], pick[j]));
      if (worst > bestScore) { bestScore = worst; best = pick; }
    }
  // Brightest first: the primary trace in every instrument is trace[0].
  best.sort((x, y) => luminance(y) - luminance(x));
  return best as [string, string, string, string];
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
  /* On-dark text variants of the three roles that appear as type rather than
     as fill. Use these for anything drawn as text on the page ground. */
  frameT: string;
  light1T: string;
  light2T: string;
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
    trace:   traceRamp(p),
    frameT:  onDark(p.frame),
    light1T: onDark(p.light1),
    light2T: onDark(p.light2),
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
  --frame-t: ${c.frameT};
  --light1-t: ${c.light1T};
  --light2-t: ${c.light2T};
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
