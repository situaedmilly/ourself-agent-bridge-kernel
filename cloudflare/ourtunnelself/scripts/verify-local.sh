#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "OURSELF LOCAL VERIFICATION"
echo "Node: $(node --version)"
echo "Repository: $ROOT"

node --check cloudflare/ourtunnelself/src/worker.js
node --check cloudflare/ourtunnelself/src/state.js
node --test cloudflare/ourtunnelself/test/worker.test.js
node --test test/ourtunnelself-command-integrity.test.js test/ourtunnelself-broker.test.js

if command -v wrangler >/dev/null 2>&1; then
  (
    cd cloudflare/ourtunnelself
    wrangler deploy --dry-run --outdir "${TMPDIR:-/tmp}/ourhostself-wrangler-dry-run"
  )
else
  echo "WRANGLER_DRY_RUN=SKIPPED (Wrangler is not installed locally)"
fi

echo "LOCAL_VERIFICATION=PASSED (see Wrangler status above; no deployment performed)"
