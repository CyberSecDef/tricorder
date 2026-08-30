#!/usr/bin/env bash
# Serve the development CA over PLAIN HTTP so a phone can fetch and install it.
#
# This has to be HTTP: the phone cannot trust our HTTPS origin until it has
# already installed this certificate, so bootstrapping over TLS is circular.
# Only the public CA certificate is served — never the private key.
set -euo pipefail

CERT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../certs" && pwd)"
PORT="${PORT:-8000}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# iOS recognises the profile by extension; .crt with PEM contents is fine.
cp "$CERT_DIR/ca-cert.pem" "$STAGE/tricorder-dev-ca.crt"

cat > "$STAGE/index.html" <<'HTML'
<!doctype html><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>Tricorder dev CA</title>
<style>
 body{background:#000;color:#ffcc99;font:16px/1.6 -apple-system,sans-serif;margin:0;padding:24px}
 h1{color:#ff9c00;letter-spacing:.08em}
 a.dl{display:block;background:#ff9c00;color:#000;text-align:center;padding:18px;
      border-radius:999px;font-weight:700;text-decoration:none;margin:20px 0;letter-spacing:.1em}
 ol{padding-left:20px} li{margin-bottom:10px} code{background:#222;padding:2px 5px;border-radius:3px}
 .warn{border-left:4px solid #ffcc00;background:#1b1508;padding:10px 12px;border-radius:3px;font-size:14px}
</style>
<h1>Tricorder dev CA</h1>
<a class=dl href="/tricorder-dev-ca.crt">Download certificate</a>
<ol>
  <li>Tap the button above. iOS says the profile was downloaded.</li>
  <li><b>Settings → General → VPN &amp; Device Management</b> → tap the downloaded profile → <b>Install</b>.</li>
  <li><b>Settings → General → About → Certificate Trust Settings</b> → switch on <b>Tricorder Dev CA</b>.</li>
</ol>
<div class=warn>Step 3 is the one everyone misses. Installing the profile is not
enough — without enabling full trust, Safari still rejects the certificate.</div>
<p>Then open the app over HTTPS. Chrome and Edge on iOS use the same system
trust store, so this works for all three browsers.</p>
HTML

echo
echo "  Serving the CA on all interfaces, port ${PORT}."
echo "  On the iPhone open:  http://$(hostname).local:${PORT}/"
echo "  Ctrl-C when the certificate is installed."
echo
cd "$STAGE"
exec python3 -m http.server "$PORT" --bind 0.0.0.0
