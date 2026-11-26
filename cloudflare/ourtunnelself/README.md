# OURHOSTSELF · Cloudflare Workers + Durable Objects

This isolated migration slice adds an independent Cloudflare serverless control plane. It does not replace the existing Node broker, modify production tunnels, admit production devices, or claim that the full ecosystem survives RAWMAC power-off.

## Verification without paid GitHub Actions

GitHub is source custody and review—not compute. No GitHub Actions workflow is required or included.

From the repository root:

    bash cloudflare/ourtunnelself/scripts/verify-local.sh

The verifier runs Node syntax checks, Worker/trust/witness contracts, a Node SQLite lifecycle test, existing OURTUNNELSELF broker regressions, and Wrangler dry-run. It does not deploy.

The guarded macOS Shortcut entrypoint is scripts/shortcut-verify.command. It invokes the same verifier and grants no authority or deployment permission.

## Deployment

Deployment is separate and requires explicit authorization. From this directory:

    npx wrangler deploy

The staging Worker is deployed at:
https://ourhostself-ourtunnelself-staging.situatedsolutions.workers.dev

No production hostname is bound. The staging Worker has no trust or delivery-signing secrets after the temporary configuration-path probe was cleaned up. Its protected routes therefore fail closed.

## Configuration

Canonical Seat/PORTAL trust is one versioned Wrangler secret:

    npx wrangler secret put TRUST_CONFIGURATION_OURSELFECOSYSTEM

See TRUST-CONFIGURATION-OURSELFECOSYSTEM.md for the exact JSON schema, staging procedure, legacy compatibility, and trust invariants. See STAGING-DEPLOYMENT-RECEIPT-2026-11-26-STATESELF.md for the latest deployed version and live readbacks.

Device delivery and DATASELF receipt signing use a separate secret:

    npx wrangler secret put OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM

This is an Ed25519 PKCS#8 private key. Its matching public key must be provisioned to authorized device agents. Never commit populated trust or signing material.

## Implemented in this slice

- Cloudflare Worker ingress and transport-only health diagnostics.
- Canonical TRUST_CONFIGURATION_OURSELFECOSYSTEM schema resolution, with temporary legacy binding compatibility and fail-closed diagnostics. A complete OSOS trust-chain validator is not yet implemented; structurally valid config remains PRESENT_UNVERIFIED and authority routes stay blocked.
- RS256 Seat and PORTAL JWT verification; issuer, audience, expiry, subject, scope, caller, target, and capability checks.
- SQLite-backed Durable Object state for devices, jobs, events, nonces, short-lived Portal admissions, and evidence receipts.
- Seat + Portal bounded device enrollment and revocation.
- Authenticated Ed25519 device poll/result routes; 60-second timestamp tolerance and atomic nonce consumption.
- Domain-separated Ed25519 delivery envelopes.
- Durable job claim state, result outbox retry in the device agent, and idempotent result acceptance.
- Worker-signed evidence receipt records, atomically committed with result state and append-only events. These are not independent witness attestations or canonical DATASELF custody.
- Caller-bound job readback, restricted to repo.status / git_status.
- Local SQLite lifecycle test covering enrollment, nonce replay, job delivery, result/evidence, revocation, and close/reopen persistence.

## Not yet established

- Cloudflare workerd/remote Durable Object end-to-end integration with signed Seat, PORTAL, and device identities.
- Independent WITNESSSELF service/trust domain and independent effect readback.
- Canonical DATASELF custody/replication adapter.
- OSOS root/subordinate certificate-chain verification, approved Seat/PORTAL issuer profile, signing-key certification/pinning, and rotation.
- Production device enrollment or command execution.
- MCP Streamable HTTP adapter and R2 evidence archive.
- Production hostname binding, production tunnel migration, and independent compute host.
- Existing tunnel/origin continuity when RAWMAC is powered off.

The local SQLite test exercises the Durable Object class SQL against Node's SQLite implementation; it is not proof of Cloudflare's remote runtime. A 200 from /health proves transport liveness only, never authority, admission, or execution.
