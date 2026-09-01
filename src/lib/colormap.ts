/**
 * Turbo colormap.
 *
 * §8.9 requires a perceptually sensible ramp and specifically forbids a raw
 * hue rotation, which produces false banding — the eye reads sharp edges at
 * the cyan and yellow transitions that are not present in the data. Turbo is
 * the standard choice for depth imagery: monotonic in lightness, high dynamic
 * range, and legible at small sizes.
 *
 * Implemented as control points with linear interpolation rather than the
 * published polynomial — same result to well within 8-bit output, far less
 * code, and readable.
 */

const STOPS: Array<[number, number, number]> = [
  [ 48,  18,  59],
  [ 70, 107, 227],
  [ 54, 174, 246],
  [ 26, 228, 182],
  [121, 252,  89],
  [216, 240,  44],
  [254, 182,  44],
  [238,  86,  17],
  [122,   4,   3],
];

/** 256-entry RGB lookup, built once. */
function buildLut(): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 3);
  const segs = STOPS.length - 1;
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * segs;
    const k = Math.min(segs - 1, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) {
      lut[i * 3 + c] = STOPS[k][c] + (STOPS[k + 1][c] - STOPS[k][c]) * f;
    }
  }
  return lut;
}

export const TURBO = buildLut();

/** Grayscale, for when the false colour is getting in the way of judging shape. */
export const GRAY = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { lut[i * 3] = lut[i * 3 + 1] = lut[i * 3 + 2] = i; }
  return lut;
})();
