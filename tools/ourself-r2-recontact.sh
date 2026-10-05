#!/bin/bash
set -euo pipefail

REPO="situaedmilly/ourself-agent-bridge-kernel"
BRANCH="mutation/communication-fabric-r2-transport-substitution-v0.1"
EXPECTED_COMMIT="245c7fdc6fec9b7eb4af990805e9a7e927759bac"

echo "=== OURSELF R2 RECONTACT ==="
gh repo view "$REPO" --json nameWithOwner,defaultBranchRef
ACTUAL_COMMIT="$(gh api "repos/$REPO/branches/$BRANCH" --jq '.commit.sha')"

echo "Expected: $EXPECTED_COMMIT"
echo "Actual:   $ACTUAL_COMMIT"

if [[ "$ACTUAL_COMMIT" != "$EXPECTED_COMMIT" ]]; then
  echo "BLOCK: exact R2 commit mismatch."
  exit 20
fi

gh pr list --repo "$REPO" --head "$BRANCH" --json number,state,isDraft,mergedAt,url
echo "PASS: exact R2 commit confirmed."
