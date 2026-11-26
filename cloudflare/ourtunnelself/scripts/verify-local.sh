#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "OURSELF LOCAL VERIFICATION"
echo "Node: $(node --version)"
echo "Repository: $ROOT"

node --check cloudflare/ourtunnelself/src/worker.js
node --check cloudflare/ourtunnelself/src/state.js
node --check cloudflare/ourtunnelself/src/witness.js
node --check runtime/ourtunnelself/device-agent.js
node --test cloudflare/ourtunnelself/test/*.test.js
node --test test/ourtunnelself-command-integrity.test.js test/ourtunnelself-broker.test.js

OUT_DIR="${TMPDIR:-/tmp}/ourhostself-wrangler-dry-run"
if command -v wrangler >/dev/null 2>&1; then
  (cd cloudflare/ourtunnelself && wrangler deploy --dry-run --outdir "$OUT_DIR")
else
  (cd cloudflare/ourtunnelself && npx --yes wrangler@4 deploy --dry-run --outdir "$OUT_DIR")
fi

echo "LOCAL_VERIFICATION=PASSED"
echo "DEPLOYMENT=NOT_PERFORMED"
