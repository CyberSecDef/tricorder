/**
 * LCARS colour schemes (§18).
 *
 * Seven of the eight palettes are sampled from CupcakeEternity's "Starfleet
 * LCARS Colour Schemes · 25th Century" chart (2021), which is already
 * organised the way a theme system needs: seven *roles* down the side, seven
 * *schemes* across the top. That structure is the reason this refactor is
 * tractable at all — the roles below are the chart's rows, not names invented
 * here.
 *
 * Values were sampled from the source image by taking a per-channel median
 * over the upper-left 55% × 62% of each swatch (avoiding the caption baked
 * into every swatch's lower-right). Channels landing within 3 of 0x00 or 0xFF
 * were snapped to the rail: those are JPEG ringing, not design intent. Nothing
 * else was adjusted, so any remaining channel is the artist's value ±2.
 *
 * GREY IS DEFERENTIALLY INCOMPLETE. The chart gives Grey Mode five swatches,
 * not seven — "Silent Operations / Power Conservation" is a deliberately
 * reduced palette. Rather than invent the two missing colours by
 * interpolation, `dark2` aliases `dark1` and `light2` aliases `light1`. The
 * reduced range is the point of the scheme; smoothing it out would be
 * inventing intent the source explicitly withheld.
 *
 * STANDARD is not from the chart. It is the palette this app already had,
 * re-expressed in the same seven roles so it can sit in the same selector.
 * The mapping was chosen to preserve the existing look exactly — see the note
 * on `RAIL_ROTATION` below.
 */

/** The chart's seven rows, in its own order (darkest structural → lightest). */
export type Role =
  | 'disabled'   // Function Disabled / Offline
  | 'dark1'      // Dark Colour 1
  | 'dark2'      // Dark Colour 2
  | 'frame'      // Frame / Shoulder Colour — the elbow and header
  | 'light1'     // Light Colour 1
  | 'light2'     // Light Colour 2
  | 'active'     // Currently Active / Selected
  | 'text';      // Body text. NOT a chart row — see below.

export type Palette = Record<Role, string>;

/*
 * `text` is the one role the chart does not supply, because a swatch chart has
 * no body copy. It is set explicitly per scheme rather than derived from
 * `active`, for two reasons: deriving it would have changed Standard's body
 * colour (Tanoi #ffcc99) into something the app never used, breaking the
 * promise that Standard is the palette we already had; and every derivation
 * rule tried produced at least one scheme that failed WCAG AA on black.
 * As set, every scheme clears 7:1 against #000 — verified in
 * tests/unit/palette.test.mjs, which fails the build rather than trusting this
 * comment.
 */

export interface Scheme {
  readonly id: ModeId;
  /** Rail label. Kept short: the rail is 78px on a phone. */
  readonly short: string;
  /** Full name as the chart gives it. */
  readonly name: string;
  /** The chart's own description of when the scheme is used. */
  readonly use: string;
  readonly palette: Palette;
}

export type ModeId =
  | 'standard' | 'normal' | 'grey' | 'maintenance'
  | 'teal' | 'blue' | 'yellow' | 'red';

export const SCHEMES: readonly Scheme[] = [
  {
    id: 'standard',
    short: 'Standard',
    name: 'Standard',
    use: 'This app’s original palette — TNG-era butterscotch and violet',
    // Chosen so RAIL_ROTATION reproduces the previous rail exactly:
    // violet, gold, bell, tangerine, in that order. frame is the
    // butterscotch elbow; active is the sunflower selected-button.
    palette: {
      disabled: '#3a3a48',
      dark1:    '#9999ff',   // Blue Bell
      dark2:    '#ff9966',   // Atomic Tangerine
      frame:    '#ff9c00',   // Butterscotch
      light1:   '#ffcc66',   // Golden Tanoi
      light2:   '#cc99cc',   // African Violet
      active:   '#ffcc00',   // Sunflower
      text:     '#ffcc99',   // Tanoi — the body colour this app already used
    },
  },
  {
    id: 'normal',
    short: 'Normal',
    name: 'Normal',
    use: 'Standard cruise / operations · Condition Green',
    palette: {
      disabled: '#333333', dark1: '#4500ac', dark2: '#8900ad',
      frame: '#7f2aff', light1: '#9a56ff', light2: '#e581ff', active: '#c7aee8',
      text: '#d9c6f2',
    },
  },
  {
    id: 'grey',
    short: 'Grey',
    name: 'Grey Mode',
    use: 'Silent operations / power conservation',
    // dark2 and light2 alias their neighbours — the chart gives Grey five
    // swatches, and the narrow range is the scheme's whole point.
    palette: {
      disabled: '#493745', dark1: '#6c5368', dark2: '#6c5368',
      frame: '#916f8a', light1: '#ac93a8', light2: '#ac93a8', active: '#cab8c6',
      text: '#d8cbd4',
    },
  },
  {
    id: 'maintenance',
    short: 'Maint',
    name: 'Maintenance',
    use: 'Repair operations',
    palette: {
      disabled: '#560000', dark1: '#803200', dark2: '#772120',
      frame: '#ff6600', light1: '#ff7f2b', light2: '#ff9856', active: '#ffb282',
      text: '#ffc9a5',
    },
  },
  {
    id: 'teal',
    short: 'Teal',
    name: 'Condition White',
    use: 'Medical emergency',
    palette: {
      disabled: '#333333', dark1: '#0088aa', dark2: '#00aa8b',
      frame: '#00a9d5', light1: '#2cffd6', light2: '#2cd3ff', active: '#acffcd',
      text: '#bdffdc',
    },
  },
  {
    id: 'blue',
    short: 'Blue',
    name: 'Blue Alert',
    use: 'Docking / separation / landing · environmental issue',
    palette: {
      disabled: '#333333', dark1: '#230058', dark2: '#000081',
      frame: '#0000d4', light1: '#2a2aff', light2: '#2b7eff', active: '#807fff',
      text: '#aeadff',
    },
  },
  {
    id: 'yellow',
    short: 'Yellow',
    name: 'Yellow Alert',
    use: 'Elevated awareness · shields online',
    palette: {
      disabled: '#333333', dark1: '#7f6600', dark2: '#803200',
      frame: '#ffcb00', light1: '#ffd52b', light2: '#ff7f2b', active: '#ffe681',
      text: '#ffeda8',
    },
  },
  {
    id: 'red',
    short: 'Red',
    name: 'Red Alert',
    use: 'Critical awareness · shields & weapons online',
    palette: {
      disabled: '#333333', dark1: '#aa0000', dark2: '#800033',
      frame: '#ff2b2a', light1: '#ff0000', light2: '#ff0066', active: '#ff8081',
      text: '#ffa9a9',
    },
  },
] as const;

/**
 * The order the four rail-button colours cycle in. For `standard` this yields
 * violet, gold, bell, tangerine — byte-identical to the hand-written
 * `nth-child` rules it replaces, which is what makes "Standard = the scheme we
 * already had" a true statement rather than an approximate one.
 */
export const RAIL_ROTATION: readonly Role[] = ['light2', 'light1', 'dark1', 'dark2'];

export const DEFAULT_MODE: ModeId = 'standard';

export const schemeOf = (id: ModeId): Scheme =>
  SCHEMES.find((s) => s.id === id) ?? SCHEMES[0];

export const isModeId = (v: unknown): v is ModeId =>
  typeof v === 'string' && SCHEMES.some((s) => s.id === v);
