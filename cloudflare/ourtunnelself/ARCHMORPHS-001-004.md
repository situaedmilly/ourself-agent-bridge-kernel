# OURHOSTSELF · Four Architecture Morphs · v0.1

Status: implementation contract; not production admission.

## ARCHMORPH-01 · SOURCSELF — GitHub as custody, not compute

**Purpose:** retain GitHub as canonical versioned source and review surface without requiring GitHub Actions.

**Execution contract**
- Source branch: `architecture/ourhostself-cloudflare-workers-do-v0.1`.
- GitHub Actions is deliberately absent.
- A local execution node fetches an explicit branch into an isolated worktree or temporary clone.
- Existing user worktrees and uncommitted changes are never overwritten.
- Commits and PR review remain provenance; neither implies deployment, admission, or runtime health.

**Acceptance evidence:** branch and commit readback; clean isolated checkout; no Actions workflow in this implementation branch.

## ARCHMORPH-02 · LOCALSELF — Node.js as local execution substrate

**Purpose:** provide a deterministic, repeatable local verification entry point.

**Execution contract**
- Node.js 22+ runs syntax, contract, and existing broker regression tests.
- Wrangler dry-run validates the Worker bundle and binding metadata.
- No command in the verification path deploys.
- Output labels distinguish test pass, dry-run pass, and deployment state.

**Acceptance evidence:** local verifier completes with 16 Worker/trust/witness/SQLite tests, 8 existing broker regression tests, Node syntax checks, and Wrangler dry-run. Remote Cloudflare Durable Object SQLite write/read and persistence across three distinct instance boot IDs are recorded in the staging receipt.

## ARCHMORPH-03 · SHORTCUTSELF — Shortcuts as operator surface

**Purpose:** let the operator invoke OURSELF's local verification without turning Shortcuts into an authority plane.

**Execution contract**
- A macOS Shortcut uses a single “Run Shell Script” action to call `cloudflare/ourtunnelself/scripts/shortcut-verify.command`.
- The wrapper resolves its own repository root, rejects execution outside the expected repository, and invokes the same canonical verifier.
- Shortcut invocation grants no seat, PORTAL admission, device authorization, or Cloudflare deployment permission.
- This repository does not silently install or modify personal Shortcuts.

**Operator setup:** create a Shortcut named `OURHOSTSELF · Verify Locally`; add “Run Shell Script”; set shell to `/bin/zsh`; paste the wrapper's absolute path after checkout. The wrapper prints the exact command result and exits nonzero on failure.

## ARCHMORPH-04 · CLOUDSELF — Cloudflare as independent resident substrate

**Purpose:** move public ingress and durable coordination off RAWMAC so Mac power-off does not remove the host control plane.

**Execution contract**
- Worker ingress + SQLite Durable Object state are the selected control-plane target.
- Device compute remains on independently admitted nodes; Cloudflare does not magically keep Mac-only compute running.
- Existing Cloudflare tunnels and Pipe|Portals are not modified during migration.
- A workers.dev staging Worker and SQLite Durable Object binding are deployed.
- TRUST_CONFIGURATION_OURSELFECOSYSTEM is implemented as a versioned configuration envelope; a staging-only probe reached PRESENT_UNVERIFIED, and protected routes correctly returned OSOS_TRUST_CHAIN_UNVERIFIED. The secret was then deleted.
- Device enrollment/revocation, authenticated poll/result, signed delivery envelopes, nonce replay protection, durable result outbox, and Worker-signed evidence receipt records are implemented in the migration branch.
- Worker-signed receipts are not independent witness attestations; separate WITNESSSELF and canonical DATASELF custody remain unimplemented.
- Production hostname and tunnel migration remain prohibited until actual OSOS/PORTAL trust material and end-to-end runtime evidence exist.

**Current evidence:** staging health returns HTTP 200 independently of RAWMAC; current trust state is MISSING and chain validation is NOT_IMPLEMENTED. A temporary structural configuration probe reached PRESENT_UNVERIFIED but could not open authority routes; cleanup returned the secret inventory to empty. Node SQLite close/reopen and actual Cloudflare Durable Object SQLite read/write across three distinct in-memory instance boot IDs are verified. Signed Seat/PORTAL/device end-to-end and RAWMAC power-off independence remain unproven.

## Cross-morph invariants

- GitHub source custody is not runtime execution.
- Shortcuts are invocation, not authority.
- Local verification is not deployment.
- Cloudflare transport health is not admission.
- Approval is not admission; admission is not actuation.
- Mac power state must not determine OURHOSTSELF control-plane availability.
- Existing tunnels and Pipe|Portal processes remain untouched until verified replacement and rollback.
