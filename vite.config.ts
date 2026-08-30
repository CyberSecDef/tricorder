import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Local TLS. iOS refuses motion / orientation / geolocation / getUserMedia
// outside a secure context, and a phone cannot use localhost — so LAN dev
// needs a real cert. See certs/README.md for generating and trusting one.
const KEY = resolve(__dirname, 'certs/server-key.pem');
const CRT = resolve(__dirname, 'certs/server-cert.pem');
const haveCerts = existsSync(KEY) && existsSync(CRT);

export default defineConfig({
  server: {
    host: true,          // bind 0.0.0.0 so the phone can reach it
    port: 5173,
    strictPort: true,
    ...(haveCerts
      ? { https: { key: readFileSync(KEY), cert: readFileSync(CRT) } }
      : {}),
  },
  build: { target: 'es2022' },
});
