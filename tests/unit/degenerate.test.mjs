/* A phone returned "1.1.1.1.1.1.1.1…" from Analyze. That is a generation loop,
 * not a wrong answer, and rendering it as prose invites the reader to interpret
 * noise. looksDegenerate() is what turns it into a diagnosis — so it has to
 * catch the real failures without libelling short, correct answers. */
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/instruments/analyze.ts --outfile=tests/.tmp/analyze.js --format=esm --bundle --external:@huggingface/transformers',
  { cwd: ROOT, stdio: 'inherit' });
const { looksDegenerate } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/analyze.js')).href);

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

console.log('\n-- real failures must be caught --');
// The exact string observed on the device.
for (const [name, s] of [
  ['the observed failure', '1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1.1'],
  ['repeated word',        'the the the the the the the the the the the'],
  ['repeated short phrase','a dog a dog a dog a dog a dog a dog a dog a dog'],
  ['digits and dots',      '0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0'],
  ['punctuation soup',     '-- -- -- -- -- -- -- -- -- -- -- -- --'],
  ['repeated comma list',  '1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1'],
]) ok(name, looksDegenerate(s) === true, JSON.stringify(s.slice(0, 40)));

console.log('\n-- genuine answers must NOT be flagged --');
// Including the one my spike actually produced, and answers that legitimately
// repeat a word or are mostly numeric.
for (const [name, s] of [
  ['the spike answer',      'A red circle.'],
  ['short and correct',     'A laptop on a desk.'],
  ['a normal description',  'A person sitting on a sofa in front of a television, with a laptop open on a coffee table.'],
  ['legitimate repetition', 'There are two dogs. One dog is black and the other dog is brown.'],
  ['a numeric answer',      'There are 3 objects: a laptop, a mug, and a phone.'],
  ['reading text aloud',    'The text reads "EXIT" in white letters on a green sign.'],
  ['an honest refusal',     'There is no text visible in this image.'],
  ['empty',                 ''],
  ['one word',              'Dog.'],
]) ok(name, looksDegenerate(s) === false, JSON.stringify(s.slice(0, 46)));

console.log('\n-- the precision table must not offer the decoder dtype that broke a phone --');
// A device returned a generation loop on `decoder_model_merged: 'q4f16'`,
// while plain `q4` answered correctly. They are different quantisations, not
// the same weights in two containers. If a future edit reintroduces q4f16 for
// the decoder, this fails rather than shipping the loop again.
const src = readFileSync(join(ROOT, 'src/instruments/analyze.ts'), 'utf8');
// Scope to the PRECISIONS table. The doc comment above it names q4f16 as the
// dtype that broke, so matching the whole file would flag the explanation.
const table = src.slice(src.indexOf('const PRECISIONS'), src.indexOf('type PrecisionId'));
const decoderDtypes = [...table.matchAll(/decoder_model_merged:\s*'([a-z0-9]+)'/g)].map((m) => m[1]);
ok('at least one precision preset is defined', decoderDtypes.length >= 3, decoderDtypes.join(', '));
ok('no preset uses q4f16 for the decoder', !decoderDtypes.includes('q4f16'), decoderDtypes.join(', '));
ok('the fast preset uses plain q4', decoderDtypes[0] === 'q4', decoderDtypes[0]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
