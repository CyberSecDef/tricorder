/**
 * Colour distribution of an image, ordered as a visible spectrum.
 *
 * ⚠️ This is NOT a spectrometer, and the distinction is not pedantry. A camera
 * has three broad, heavily overlapping colour channels, and infinitely many
 * different spectral power distributions produce identical RGB — that is
 * metamerism, and it is why a screen can show you "yellow" with no 580 nm
 * light in it at all. Nothing here can distinguish monochromatic yellow from
 * red-plus-green.
 *
 * What this measures is real and useful anyway: how much of each HUE is
 * present in the scene. A blue room genuinely produces a blue-heavy
 * distribution. The wavelength labels are an approximate mapping from hue,
 * offered because they make the display legible, and they are labelled as
 * approximate in the UI.
 *
 * DOM-free so the binning and the colour maths can be tested.
 */

/** Bins across the spectral hue range. 5 degrees each. */
export const BINS = 56;
/**
 * Hue degrees spanned. 0 (red) through 280 (violet).
 *
 * Deliberately stops short of 360. Hues from roughly 285 to 360 are the
 * magentas and purples, and those are NOT spectral colours — no single
 * wavelength produces magenta. It is what the eye reports when long and short
 * cones fire together without the middle. Folding them into a wavelength axis
 * would be inventing a physical claim, so they are counted separately.
 */
export const HUE_SPAN = 280;

export interface HueDistribution {
  /** Per-bin weight, normalised so the largest bin is 1. */
  bins: Float32Array;
  /** Unnormalised total weight, for comparing frames. */
  total: number;
  /** Fraction of pixels too grey to have a meaningful hue. */
  achromatic: number;
  /** Fraction in the non-spectral magenta/purple range. */
  nonSpectral: number;
  /** Bin index of the strongest hue, or -1 when nothing is coloured. */
  peakBin: number;
  /** Mean saturation of the chromatic pixels, 0..1. */
  meanSaturation: number;
}

/**
 * Bin an RGBA buffer by hue.
 *
 * Weighting is saturation times value, not a flat count. A nearly-grey pixel
 * has a hue in the arithmetic sense but it carries almost no colour
 * information, and counting it equally would make every scene look like a flat
 * wash across the whole spectrum. A dark pixel is likewise unreliable — hue
 * gets noisy as value approaches zero.
 */
export function hueDistribution(
  data: Uint8ClampedArray,
  opts: { minSaturation?: number; minValue?: number } = {},
): HueDistribution {
  const minSat = opts.minSaturation ?? 0.12;
  const minVal = opts.minValue ?? 0.08;

  const bins = new Float32Array(BINS);
  let total = 0;
  let achromatic = 0;
  let nonSpectral = 0;
  let satSum = 0;
  let chromatic = 0;
  const pixels = data.length >> 2;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = r > g ? (r > b ? r : b) : (g > b ? g : b);
    const min = r < g ? (r < b ? r : b) : (g < b ? g : b);
    const v = max;
    const d = max - min;
    const s = max <= 0 ? 0 : d / max;

    if (s < minSat || v < minVal) { achromatic++; continue; }

    let h: number;
    if (d === 0) h = 0;
    else if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;

    chromatic++;
    satSum += s;

    if (h > HUE_SPAN) { nonSpectral++; continue; }

    const bin = Math.min(BINS - 1, Math.floor((h / HUE_SPAN) * BINS));
    const w = s * v;
    bins[bin] += w;
    total += w;
  }

  let peakBin = -1, peakVal = 0;
  for (let i = 0; i < BINS; i++) if (bins[i] > peakVal) { peakVal = bins[i]; peakBin = i; }
  if (peakVal > 0) for (let i = 0; i < BINS; i++) bins[i] /= peakVal;

  return {
    bins,
    total,
    achromatic: pixels ? achromatic / pixels : 0,
    nonSpectral: pixels ? nonSpectral / pixels : 0,
    peakBin,
    meanSaturation: chromatic ? satSum / chromatic : 0,
  };
}

/** Centre hue of a bin, in degrees. */
export const binHue = (bin: number): number => ((bin + 0.5) / BINS) * HUE_SPAN;

/**
 * Approximate wavelength for a hue, in nanometres.
 *
 * Piecewise through the standard anchors. Approximate by nature: the mapping
 * from a camera's three-channel hue back to a wavelength is not a physical
 * inversion, it is a convention that happens to line up with how people name
 * colours. Presented as a label, never as a measurement.
 */
export function hueToWavelength(hue: number): number {
  const anchors: Array<[number, number]> = [
    [0, 700], [30, 620], [60, 580], [90, 555],
    [120, 530], [150, 505], [180, 490], [210, 475],
    [240, 460], [270, 420], [280, 405],
  ];
  const h = Math.max(0, Math.min(HUE_SPAN, hue));
  for (let i = 0; i < anchors.length - 1; i++) {
    const [h0, w0] = anchors[i];
    const [h1, w1] = anchors[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return w0 + (w1 - w0) * t;
    }
  }
  return 405;
}

/** Fully saturated CSS colour for a bin, for painting the bars. */
export function binColor(bin: number, value = 1): string {
  return `hsl(${binHue(bin).toFixed(1)} 100% ${(50 * Math.max(0.35, value)).toFixed(0)}%)`;
}
