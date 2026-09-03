#!/usr/bin/env node
/**
 * Test runner.
 *
 *   node tests/run.mjs unit      pure logic, no browser, no server
 *   node tests/run.mjs browser   needs a dev server and playwright-core
 *   node tests/run.mjs           both
 *
 * Environment:
 *   TRICORDER_URL   default https://localhost:5173/
 *   CHROME_PATH     default the playwright chromium under ~/.cache
 *
 * These report by printing PASS/FAIL lines; a suite fails if any line says
 * FAIL or if the process exits non-zero. Deliberately not a framework — the
 * value here is in the assertions, most of which check numbers against
 * closed-form answers, and a runner should not get in the way of reading them.
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const which = process.argv[2];
// `retired/` is deliberately absent: those suites target instruments that are
// no longer in the rail, so they cannot run against the app as shipped. See
// tests/retired/README.md.
const kinds = which ? [which] : ['unit', 'browser'];

let failed = 0, ran = 0;
for (const kind of kinds) {
  const dir = join(here, kind);
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();
  console.log(`\n=== ${kind} (${files.length}) ===`);
  for (const f of files) {
    const r = spawnSync(process.execPath, [join(dir, f)], { encoding: 'utf8', cwd: here });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    const bad = r.status !== 0 || /\bFAIL\b|ERRORS:/.test(out);
    console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${f}`);
    if (bad) {
      failed++;
      const hits = out.split('\n').filter((l) => /FAIL|ERROR/.test(l)).slice(0, 4);
      if (hits.length) {
        for (const line of hits) console.log(`          ${line.trim()}`);
      } else {
        // A suite can fail with no FAIL line at all — a throw, a timeout, a
        // browser that would not launch. Printing nothing there is how a
        // process-level failure gets mistaken for flakiness, so say what
        // actually happened.
        console.log(`          exited ${r.status === null ? `on signal ${r.signal}` : `with code ${r.status}`}, no FAIL line`);
        for (const line of out.trimEnd().split('\n').slice(-6)) {
          console.log(`          | ${line.trim()}`);
        }
      }
    }
    ran++;
  }
}
console.log(`\n${ran - failed}/${ran} suites passed`);
process.exit(failed ? 1 : 0);
