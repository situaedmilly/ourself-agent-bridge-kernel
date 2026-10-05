#!/bin/bash
set -euo pipefail

REPO_DIR="${OURSELF_REPO_DIR:-/Users/millysituated/RUORA/projects/ourself-agent-bridge-kernel}"
cd "$REPO_DIR"

echo "OURSELF ACTION"
echo "=============="
echo "R2 LOCAL EXECUTION WITNESS"
echo
echo "Branch: $(git branch --show-current)"
echo "Commit: $(git rev-parse HEAD)"
echo "Command: node --test test/communication-fabric-r2.test.js"
echo "Authority: OURSELF"
echo "Execution surface: LOCAL_TERMINAL"
echo
read -r -p 'OURSELF AUTHORIZE EXACT EXECUTION? [type EXECUTE]: ' APPROVAL
[[ "$APPROVAL" == "EXECUTE" ]] || { echo "BLOCKED — no execution authority supplied."; exit 40; }

exec ./tools/ourself-local-test-witness.sh
