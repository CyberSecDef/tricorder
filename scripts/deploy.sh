#!/usr/bin/env bash
# Build and deploy to DreamHost.
#
#   npm run deploy            build, sync, verify
#   npm run deploy -- --dry   show what would change, touch nothing
#
# Credentials come from .env.local, which is gitignored and must stay that way:
#   DREAMHOST_USER, DREAMHOST_PASS, DREAMHOST_HOST, PROD_URL
#
# The password is passed to sshpass through the environment (`-e`), never on a
# command line, so it does not appear in `ps` output.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env.local ] || { echo "no .env.local — cannot deploy" >&2; exit 1; }
set -a; . ./.env.local; set +a
: "${DREAMHOST_USER:?}" "${DREAMHOST_PASS:?}" "${DREAMHOST_HOST:?}" "${PROD_URL:?}"

DRY=""
[ "${1:-}" = "--dry" ] && DRY="--dry-run --itemize-changes"

# A deploy that ships uncommitted work makes About's provenance row a lie: it
# would print a commit hash for code that is not the code running. Warn loudly;
# do not block, since an emergency fix is a real thing.
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "WARNING: working tree is dirty. About will say '+ uncommitted changes'." >&2
fi

echo "==> building"
npm run build

echo "==> syncing to $DREAMHOST_HOST:probe.trackr.live/public/"
export SSHPASS="$DREAMHOST_PASS"
# --delete keeps the remote an exact mirror; .dh-diag is a root-owned symlink
# DreamHost puts there and rsync cannot remove it, so it is excluded.
rsync -az --delete --exclude '.dh-diag' $DRY --info=stats1 \
  -e "sshpass -e ssh -o StrictHostKeyChecking=accept-new" \
  dist/ "$DREAMHOST_USER@$DREAMHOST_HOST:probe.trackr.live/public/"

[ -n "$DRY" ] && { echo "(dry run — nothing changed)"; exit 0; }

echo "==> verifying"
fail=0
check() { # path expected-content-type
  local ct; ct=$(curl -sI "$PROD_URL$1" | awk 'BEGIN{IGNORECASE=1}/^content-type:/{print $2}' | tr -d '\r;')
  local code; code=$(curl -s -o /dev/null -w '%{http_code}' "$PROD_URL$1")
  if [ "$code" = "200" ] && [ "$ct" = "$2" ]; then printf '  ok   %-46s %s\n' "$1" "$ct"
  else printf '  FAIL %-46s %s %s (wanted 200 %s)\n' "$1" "$code" "$ct" "$2"; fail=1; fi
}
check / text/html
# The one that silently breaks Depth and Analyze if Apache guesses: streaming
# WebAssembly compilation refuses anything but application/wasm.
check /ort/ort-wasm-simd-threaded.jsep.wasm application/wasm
check /fonts/antonio-latin.woff2 font/woff2

[ "$fail" = 0 ] && echo "==> deployed: $PROD_URL" || { echo "==> deploy verified BAD" >&2; exit 1; }
