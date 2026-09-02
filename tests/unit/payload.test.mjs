import { execSync } from 'node:child_process';

import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
execSync('npx esbuild src/lib/payload.ts --outfile=tests/.tmp/payload.js --format=esm --bundle',
  { cwd: ROOT, stdio: 'inherit' });
const { analyse, makeVisible } = await import(pathToFileURL(join(ROOT, 'tests/.tmp/payload.js')).href);

let pass=0, fail=0;
const check = (label, cond, detail='') => { console.log(`  ${cond?'PASS':'FAIL'}  ${label}${detail?'  — '+detail:''}`); cond?pass++:fail++; };

console.log('\nclassification:');
check('https URL', analyse('https://example.com/a?b=1').kind === 'url');
check('bare domain treated as a link', analyse('example.com/x').kind === 'url');
check('wifi', analyse('WIFI:T:WPA;S:MyNet;P:hunter2;;').kind === 'wifi');
check('vcard', analyse('BEGIN:VCARD\nFN:A\nEND:VCARD').kind === 'vcard');
check('mailto', analyse('mailto:a@b.com').kind === 'mailto');
check('tel', analyse('tel:+15551234').kind === 'tel');
check('plain text stays text', analyse('just some words here').kind === 'text');

console.log('\nurl fields:');
{
  const a = analyse('https://user:pw@xn--80ak6aa92e.com:8443/path?q=1');
  const f = Object.fromEntries(a.fields);
  check('host extracted', f.Host === 'xn--80ak6aa92e.com', f.Host);
  check('port extracted', f.Port === '8443');
  check('credentials flagged', a.warnings.some(w=>/embedded credentials/.test(w)));
  check('punycode flagged', a.warnings.some(w=>/punycode/.test(w)));
}

console.log('\ndangerous schemes:');
for (const s of ['javascript:alert(1)','data:text/html,<script>x</script>','file:///etc/passwd']) {
  const a = analyse(s);
  check(s.split(':')[0], a.warnings.some(w=>/executes or embeds/.test(w)));
}

console.log('\ndeceptive characters:');
{
  const bidi = 'https://exam' + String.fromCharCode(0x202E) + 'elpm.com';
  const a = analyse(bidi);
  check('bidi override detected', a.deceptive && a.warnings.some(w=>/bidirectional/.test(w)));
  check('made visible', makeVisible(bidi).includes('<U+202E>'), makeVisible(bidi));
  const zw = 'pay' + String.fromCharCode(0x200B) + 'pal.com';
  check('zero-width detected', analyse(zw).deceptive);
  const ctrl = 'abc' + String.fromCharCode(0x07) + 'def';
  check('control char detected', analyse(ctrl).deceptive);
}

console.log('\nother warnings:');
check('http flagged as unencrypted', analyse('http://example.com').warnings.some(w=>/unencrypted/.test(w)));
check('raw IP flagged', analyse('https://192.168.1.1/x').warnings.some(w=>/raw IP/.test(w)));
check('open wifi flagged', analyse('WIFI:T:nopass;S:Free;;').warnings.some(w=>/open/i.test(w)));
check('clean https has no warnings', analyse('https://example.com/').warnings.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
