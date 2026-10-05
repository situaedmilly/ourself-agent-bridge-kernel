#!/bin/bash
set -euo pipefail

REPO="situaedmilly/ourself-agent-bridge-kernel"
BRANCH="mutation/communication-fabric-r2-transport-substitution-v0.1"
EXPECTED_COMMIT="245c7fdc6fec9b7eb4af990805e9a7e927759bac"
TEST_PATH="test/communication-fabric-r2.test.js"

REPO_DIR="${OURSELF_REPO_DIR:-/Users/millysituated/RUORA/projects/ourself-agent-bridge-kernel}"
RECEIPT_DIR="$REPO_DIR/proof/local-execution"
RECEIPT="$RECEIPT_DIR/r2-local-execution-receipt.json"

cd "$REPO_DIR"

echo "=== OURSELF LOCAL EXECUTION WITNESS ==="

ACTUAL_REMOTE="$(git remote get-url origin 2>/dev/null || true)"
ACTUAL_BRANCH="$(git branch --show-current)"
ACTUAL_COMMIT="$(git rev-parse HEAD)"

echo "Repository: $ACTUAL_REMOTE"
echo "Branch:     $ACTUAL_BRANCH"
echo "Commit:     $ACTUAL_COMMIT"

[[ "$ACTUAL_BRANCH" == "$BRANCH" ]] || { echo "BLOCK: branch mismatch."; exit 21; }
[[ "$ACTUAL_COMMIT" == "$EXPECTED_COMMIT" ]] || { echo "BLOCK: commit mismatch."; exit 22; }

DIRTY="$(git status --porcelain --untracked-files=all | grep -v "^?? proof/local-execution/r2-local-execution-receipt.json$" || true)"
if [[ -n "$DIRTY" ]]; then
  echo "BLOCK: working tree is dirty before execution."
  printf "%s\n" "$DIRTY"
  exit 23
fi

mkdir -p "$RECEIPT_DIR"
echo "[1] npm ci"
npm ci

echo "[2] exact R2 test"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
TMP_OUT="$(mktemp)"
TMP_ERR="$(mktemp)"

set +e
node --test "$TEST_PATH" >"$TMP_OUT" 2>"$TMP_ERR"
EXIT_CODE=$?
set -e

COMPLETED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cat "$TMP_OUT"
cat "$TMP_ERR" >&2

STDOUT_SHA256="$(shasum -a 256 "$TMP_OUT" | awk '{print $1}')"
STDERR_SHA256="$(shasum -a 256 "$TMP_ERR" | awk '{print $1}')"

export REPO BRANCH EXPECTED_COMMIT TEST_PATH STARTED_AT COMPLETED_AT EXIT_CODE
export STDOUT_SHA256 STDERR_SHA256
export APPROVAL_COMMAND_ID="${OURSELF_APPROVAL_COMMAND_ID:-}"
export APPROVAL_AT="${OURSELF_APPROVAL_AT:-}"

python3 - "$RECEIPT" <<'PY'
import json, os, sys

receipt = {
    "schema": "OURSELF_LOCAL_EXECUTION_RECEIPT_V0.1",
    "repository": os.environ["REPO"],
    "branch": os.environ["BRANCH"],
    "commit": os.environ["EXPECTED_COMMIT"],
    "test_path": os.environ["TEST_PATH"],
    "command": "node --test test/communication-fabric-r2.test.js",
    "authority": "OURSELF",
    "execution_surface": "LOCAL_TERMINAL",
    "status": "PASSED" if os.environ["EXIT_CODE"] == "0" else "FAILED",
    "exit_code": int(os.environ["EXIT_CODE"]),
    "stdout_sha256": os.environ["STDOUT_SHA256"],
    "stderr_sha256": os.environ["STDERR_SHA256"],
    "started_at": os.environ["STARTED_AT"],
    "completed_at": os.environ["COMPLETED_AT"],
    "approval_command_id": os.environ["APPROVAL_COMMAND_ID"] or None,
    "approval_at": os.environ["APPROVAL_AT"] or None
}

with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(receipt, f, indent=2)
    f.write("\n")
PY

rm -f "$TMP_OUT" "$TMP_ERR"

cat "$RECEIPT"

if [[ "$EXIT_CODE" != "0" ]]; then
  echo "R2 LOCAL EXECUTION: FAILED"
  exit "$EXIT_CODE"
fi

echo "R2 LOCAL EXECUTION: PASSED"
