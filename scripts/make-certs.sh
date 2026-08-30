#!/usr/bin/env bash
# Generate a local development CA and a leaf certificate for LAN HTTPS.
#
# iOS requires a secure context for DeviceMotion, DeviceOrientation,
# Geolocation and getUserMedia, and a phone cannot use localhost — so LAN
# development needs a genuinely trusted certificate. This is the mkcert
# workflow, done with plain openssl so there is nothing extra to install.
#
# Re-run this whenever the machine's LAN IP changes. Then re-install the CA on
# the phone ONLY if you regenerated the CA itself (this script reuses an
# existing ca-cert.pem/ca-key.pem pair when present, so you usually do not).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$DIR"
cd "$DIR"

HOSTNAME_LOCAL="$(hostname).local"
# Every global IPv4 the machine currently holds, so the phone can reach us on
# whichever network it shares with us (LAN, ZeroTier, Tailscale...).
mapfile -t IPS < <(ip -4 addr show scope global | grep -oP 'inet \K[\d.]+')

{
  echo "[req]"
  echo "distinguished_name = dn"
  echo "[dn]"
  echo "[ext]"
  echo "basicConstraints = CA:FALSE"
  echo "keyUsage = critical, digitalSignature, keyEncipherment"
  echo "extendedKeyUsage = serverAuth"
  echo "subjectAltName = @alt"
  echo "[alt]"
  echo "DNS.1 = ${HOSTNAME_LOCAL}"
  echo "DNS.2 = localhost"
  i=1
  for ip in "${IPS[@]}"; do echo "IP.${i} = ${ip}"; i=$((i+1)); done
  echo "IP.${i} = 127.0.0.1"
} > san.cnf

if [[ -f ca-cert.pem && -f ca-key.pem ]]; then
  echo "Reusing existing CA (no need to re-install it on the phone)."
else
  echo "Creating a new CA — you will need to install this on the phone."
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout ca-key.pem -out ca-cert.pem \
    -subj "/CN=Tricorder Dev CA/O=Tricorder Local Development"
fi

openssl req -newkey rsa:2048 -nodes -sha256 \
  -keyout server-key.pem -out server.csr -subj "/CN=${HOSTNAME_LOCAL}"

# 825 days is the maximum lifetime Apple platforms accept for a server cert.
openssl x509 -req -in server.csr -CA ca-cert.pem -CAkey ca-key.pem \
  -CAcreateserial -out server-cert.pem -days 825 -sha256 \
  -extfile san.cnf -extensions ext

rm -f server.csr ca-cert.srl
chmod 600 ca-key.pem server-key.pem

echo
echo "Leaf certificate covers:"
openssl x509 -in server-cert.pem -noout -text | grep -A1 "Subject Alternative Name" | tail -1
echo
echo "Next: npm run serve-ca   (install the CA on the phone), then npm run dev"
