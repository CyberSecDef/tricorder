import { defineConfig } from 'vite';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Build provenance for the About panel (§19).
 *
 * `dirty` is reported alongside the commit rather than being folded into it,
 * because a hash taken from a modified working tree is a claim about code that
 * is not the code running. About says "at <hash>, with uncommitted changes"
 * when that is the truth, which is the difference between provenance and
 * decoration. Every field degrades to a stated unknown — none of this is
 * allowed to fail a build, and none of it may guess.
 */
function git(cmd: string): string | null {
  try { return execSync(`git ${cmd}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'));

/**
 * Is the working tree actually modified?
 *
 * The naive `git status --porcelain !== ''` is WRONG here, and wrong in the
 * direction that matters: it reported dirty on every single build, including
 * clean release builds, so About's provenance row said "+ uncommitted changes"
 * for a perfectly reproducible commit. Vite loads a TypeScript config by
 * writing `vite.config.ts.timestamp-*.mjs` NEXT TO IT — in the project root —
 * and deleting it afterwards. That file exists precisely while this code runs.
 * The build was observing its own build tool.
 *
 * Filtered rather than fixed with .gitignore alone, so the answer does not
 * depend on a gitignore entry someone could reasonably tidy away.
 */
function isDirty(): boolean | null {
  const status = git('status --porcelain');
  if (status === null) return null;
  return status
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/vite\.config\.[^\s]*timestamp-/.test(l))
    .length > 0;
}

const BUILD = {
  version: pkg.version ?? null,
  commit: git('rev-parse --short HEAD'),
  branch: git('rev-parse --abbrev-ref HEAD'),
  committedAt: git('log -1 --format=%cI'),
  dirty: isDirty(),
  builtAt: new Date().toISOString(),
};

// Local TLS. iOS refuses motion / orientation / geolocation / getUserMedia
// outside a secure context, and a phone cannot use localhost — so LAN dev
// needs a real cert. See certs/README.md for generating and trusting one.
const KEY = resolve(__dirname, 'certs/server-key.pem');
const CRT = resolve(__dirname, 'certs/server-cert.pem');
const haveCerts = existsSync(KEY) && existsSync(CRT);

/**
 * Rollup resolves onnxruntime-web's `new URL('...wasm', import.meta.url)` and
 * emits a 23 MB binary into the bundle — and it emits the *asyncify* variant,
 * which is neither the WebGPU build nor the plain fallback we actually use.
 * We serve our own from /ort/ (see scripts/copy-ort.mjs), so this is pure dead
 * weight in the deploy. Drop it.
 */
/**
 * Serve /ort/* raw in dev.
 *
 * The ONNX runtime loads its glue with a dynamic `import()`, which drags the
 * file into Vite's module graph — the dev server then tries to transform an
 * emscripten bundle as an ES module and returns a 500. Production is fine,
 * because `vite preview` and any static host serve public/ untouched, so this
 * is a case where dev and production genuinely differ and only dev is broken.
 * Intercept before the transform pipeline sees it.
 */
function serveOrtRawInDev() {
  return {
    name: 'serve-ort-raw-in-dev',
    apply: 'serve' as const,
    configureServer(server: any) {
      server.middlewares.use((req: any, res: any, next: () => void) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith('/ort/')) return next();
        const file = resolve(__dirname, 'public', path.slice(1));
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type',
          file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

function dropBundledOrtWasm() {
  return {
    name: 'drop-bundled-ort-wasm',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [serveOrtRawInDev(), dropBundledOrtWasm()],
  server: {
    host: true,          // bind 0.0.0.0 so the phone can reach it
    port: 5173,
    strictPort: true,
    ...(haveCerts
      ? { https: { key: readFileSync(KEY), cert: readFileSync(CRT) } }
      : {}),
  },
  // Same TLS for `vite preview`, so the production bundle can be exercised on
  // the phone and in tests. Worth having: the dev server transforms files out
  // of public/ as modules, which the ONNX runtime's .mjs glue does not
  // survive, so dev and production genuinely differ here.
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
    ...(haveCerts
      ? { https: { key: readFileSync(KEY), cert: readFileSync(CRT) } }
      : {}),
  },
  build: {
    target: 'es2022',
    /**
     * Never inline the AudioWorklet.
     *
     * Vite inlines small assets as `data:` URLs, and the sonar worklet is well
     * under the threshold — but `audioWorklet.addModule()` on a data URL is
     * not reliably supported, and it is exactly the kind of thing that works
     * in desktop Chromium and fails on WebKit. Emit it as a real file.
     */
    assetsInlineLimit(filePath: string) {
      if (/sonar-worklet\.js$/.test(filePath)) return false;
      return undefined;   // default behaviour for everything else
    },
  },
});
