/* The palette is data, and data that is wrong is wrong silently — a scheme
 * with an unreadable text colour or a missing role looks fine in review and
 * fails on a phone in daylight. These assertions are the reason the comments
 * in ui/palette.ts are allowed to make claims. */
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/ui/theme.ts --outfile=tests/.tmp/theme.js --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const T = await import(pathToFileURL(join(ROOT, 'tests/.tmp/theme.js')).href);
execSync('npx esbuild src/ui/palette.ts --outfile=tests/.tmp/palette.js --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const P = await import(pathToFileURL(join(ROOT, 'tests/.tmp/palette.js')).href);

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

const ROLES = ['disabled', 'dark1', 'dark2', 'frame', 'light1', 'light2', 'active', 'text'];
const HEX = /^#[0-9a-f]{6}$/;

console.log('\n-- every scheme is complete and well-formed --');
ok('eight schemes', P.SCHEMES.length === 8, `${P.SCHEMES.length}`);
for (const s of P.SCHEMES) {
  const missing = ROLES.filter((r) => !HEX.test(s.palette[r] ?? ''));
  ok(`${s.id}: all ${ROLES.length} roles are #rrggbb`, missing.length === 0, missing.join(', '));
}
ok('ids are unique', new Set(P.SCHEMES.map((s) => s.id)).size === 8);
ok('every scheme has a use description',
   P.SCHEMES.every((s) => typeof s.use === 'string' && s.use.length > 8));

console.log('\n-- body text is readable on black in every scheme --');
// 7:1 is WCAG AAA for body text. The claim is made in a comment in
// palette.ts; this is what makes it true rather than aspirational.
for (const s of P.SCHEMES) {
  const c = T.contrast(s.palette.text, '#000000');
  ok(`${s.id}: text vs black >= 7:1`, c >= 7, `${c.toFixed(2)}:1`);
}

console.log('\n-- Standard really is the palette the app already had --');
// If this drifts, the selector is quietly lying to anyone who picks Standard
// expecting the scheme they have been looking at for two weeks.
const std = P.schemeOf('standard').palette;
ok('frame is Butterscotch #ff9c00', std.frame === '#ff9c00', std.frame);
ok('active is Sunflower #ffcc00', std.active === '#ffcc00', std.active);
ok('text is Tanoi #ffcc99', std.text === '#ffcc99', std.text);
const rail = P.RAIL_ROTATION.map((r) => std[r]);
ok('rail cycles violet, gold, bell, tangerine — the exact previous nth-child order',
   rail.join(',') === '#cc99cc,#ffcc66,#9999ff,#ff9966', rail.join(', '));

console.log('\n-- Grey is deferentially incomplete, not accidentally broken --');
const grey = P.schemeOf('grey').palette;
ok('grey dark2 aliases dark1', grey.dark2 === grey.dark1, grey.dark2);
ok('grey light2 aliases light1', grey.light2 === grey.light1, grey.light2);
ok('no other scheme aliases its dark pair',
   P.SCHEMES.filter((s) => s.id !== 'grey').every((s) => s.palette.dark1 !== s.palette.dark2));

console.log('\n-- state colours are constant across schemes --');
// The whole point of the carve-out: an alert mode must not make ok/warn/bad
// indistinguishable. If someone later themes these, this fails loudly.
const css = P.SCHEMES.map((s) => T.cssFor(s.palette, `:root[data-mode="${s.id}"]`));
ok('--ok identical in all 8 blocks',
   new Set(css.map((b) => /--ok: (\S+);/.exec(b)[1])).size === 1);
ok('--warn identical in all 8 blocks',
   new Set(css.map((b) => /--warn: (\S+);/.exec(b)[1])).size === 1);
ok('--bad identical in all 8 blocks',
   new Set(css.map((b) => /--bad: (\S+);/.exec(b)[1])).size === 1);
// Distinguishability is NOT a contrast ratio. WCAG contrast is a ratio of
// relative luminances, so it reports two colours as near-identical whenever
// they are equally bright regardless of hue — which is exactly the case for
// this green and this yellow (1.33:1, yet nobody would confuse them). The
// property actually wanted here is perceptual colour difference, so measure
// that: CIE76 dE in L*a*b*, where dE > 25 is "obviously a different colour"
// well beyond the ~2.3 just-noticeable threshold.
function lab(hex) {
  const v = hex.replace('#', '');
  const n = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  const srgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = srgb.map((u) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4));
  // sRGB D65 -> XYZ, then normalised by the D65 white point
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.0;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(X), f(Y), f(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));

const okc = T.OK, badc = T.BAD, warnc = T.WARN;
const pairs = [['ok', okc, 'bad', badc], ['warn', warnc, 'bad', badc], ['ok', okc, 'warn', warnc]];
for (const [an, a, bn, b] of pairs) {
  ok(`${an} vs ${bn}: perceptually distinct (dE76 > 25)`, dE(a, b) > 25,
     `dE ${dE(a, b).toFixed(1)}, contrast only ${T.contrast(a, b).toFixed(2)}:1`);
}

console.log('\n-- rail labels are legible on every swatch of every scheme --');
// Found by screenshot, not by reasoning: the rail always drew its label in
// black, which is fine for Standard (four light swatches) and unreadable in
// Red and Blue Alert, whose dark1/dark2 are nearly black. ink() picks per
// swatch; this is what stops it silently regressing.
for (const s of P.SCHEMES) {
  const worst = P.RAIL_ROTATION.map((r) => {
    const bg = s.palette[r];
    return { bg, ratio: T.contrast(bg, T.ink(bg, s.palette.text)) };
  }).sort((a, b) => a.ratio - b.ratio)[0];
  ok(`${s.id}: worst rail label >= 4.5:1`, worst.ratio >= 4.5,
     `${worst.ratio.toFixed(2)}:1 on ${worst.bg}`);
}
ok('ink() actually switches, rather than always returning black',
   new Set(P.SCHEMES.flatMap((s) => P.RAIL_ROTATION.map((r) => T.ink(s.palette[r], s.palette.text)))).size > 1);

console.log('\n-- text roles are legible on the page ground in every scheme --');
// The chart's roles are FILLS. `frame` is literally "Frame / Shoulder Colour"
// — the elbow and the header bar — and using it for section headings worked
// only because Standard's Butterscotch is bright. Blue Alert's frame sits at
// 1.95:1 on black. The -t variants are what headings and values actually use.
for (const s of P.SCHEMES) {
  for (const role of ['frame', 'light1', 'light2']) {
    const lifted = T.onDark(s.palette[role]);
    ok(`${s.id}: ${role} as text >= ${T.TEXT_MIN}:1`, T.contrast(lifted, '#000000') >= T.TEXT_MIN - 0.01,
       `${s.palette[role]} ${T.contrast(s.palette[role], '#000000').toFixed(2)} -> ${lifted} ${T.contrast(lifted, '#000000').toFixed(2)}`);
  }
}
ok('schemes that were already bright are left alone',
   ['standard', 'maintenance', 'teal', 'yellow'].every((id) => {
     const q = P.schemeOf(id).palette;
     return T.onDark(q.frame) === q.frame && T.onDark(q.light1) === q.light1;
   }));

console.log('\n-- multi-series traces are visible AND mutually distinguishable --');
// Grey aliases light2 to light1, so a fixed [light1, light2, ...] ramp handed
// the seismograph the same colour for X and Y — two axes impossible to tell
// apart. traceRamp() picks for separation instead of by name.
for (const s of P.SCHEMES) {
  const tr = T.traceRamp(s.palette);
  ok(`${s.id}: four distinct trace colours`, new Set(tr).size === 4, tr.join(' '));
  const minC = Math.min(...tr.map((t) => T.contrast(t, '#000000')));
  ok(`${s.id}: dimmest trace visible on black (>= 4.5:1)`, minC >= 4.49, `${minC.toFixed(2)}:1`);
  let minD = Infinity;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) minD = Math.min(minD, T.deltaE(tr[i], tr[j]));
  // Grey Mode is five mauve-greys by design, so it gets a lower bar than the
  // schemes that have hue to spend. Above the ~2.3 JND either way.
  const floor = s.id === 'grey' ? 6 : 15;
  ok(`${s.id}: closest trace pair dE >= ${floor}`, minD >= floor, `dE ${minD.toFixed(1)}`);
}

console.log('\n-- generated CSS covers every token lcars.css consumes --');
const NEEDED = ['--disabled','--dark1','--dark2','--frame','--light1','--light2','--active',
                '--text','--rail-1','--rail-2','--rail-3','--rail-4','--text-dim',
                '--text-dimmer','--grid','--grid-mid','--ok','--warn','--bad',
                '--frame-t','--light1-t','--light2-t'];
for (const s of P.SCHEMES) {
  const block = T.cssFor(s.palette, ':root');
  const missing = NEEDED.filter((t) => !block.includes(`${t}:`));
  ok(`${s.id}: emits all ${NEEDED.length} role tokens`, missing.length === 0, missing.join(', '));
}

console.log('\n-- colour maths --');
ok('mix endpoints', T.mix('#000000', '#ffffff', 0) === '#000000' && T.mix('#000000', '#ffffff', 1) === '#ffffff');
ok('mix midpoint', T.mix('#000000', '#ffffff', 0.5) === '#808080', T.mix('#000000', '#ffffff', 0.5));
ok('alpha appends two hex digits', T.alpha('#ff9c00', 0.4) === '#ff9c0066', T.alpha('#ff9c00', 0.4));
ok('alpha clamps', T.alpha('#ffffff', 2) === '#ffffffff' && T.alpha('#ffffff', -1) === '#ffffff00');
ok('contrast of black on white is 21', Math.round(T.contrast('#000', '#fff')) === 21);
ok('contrast is symmetric', T.contrast('#ff9c00', '#000') === T.contrast('#000', '#ff9c00'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
