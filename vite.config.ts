import { defineConfig } from 'vite';
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { resolve } from 'node:path';

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
  build: { target: 'es2022' },
});
