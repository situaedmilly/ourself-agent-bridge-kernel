#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd -P)"
EXPECTED_REMOTE="https://github.com/situaedmilly/ourself-agent-bridge-kernel.git"

if [[ ! -d "$REPO_ROOT/.git" ]]; then
  print -u2 "BLOCKED: expected repository root not found: $REPO_ROOT"
  exit 20
fi

REMOTE="$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)"
if [[ "$REMOTE" != "$EXPECTED_REMOTE" ]]; then
  print -u2 "BLOCKED: repository origin mismatch; refusing to run."
  exit 21
fi

exec /bin/bash "$REPO_ROOT/cloudflare/ourtunnelself/scripts/verify-local.sh"
