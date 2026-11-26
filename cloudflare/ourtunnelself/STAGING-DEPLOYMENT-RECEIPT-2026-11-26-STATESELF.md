# OURHOSTSELF · STATESELF / DEVICESELF / WITNESSSELF staging deployment receipt

Date: 2026-11-26 UTC
Environment: isolated Cloudflare Workers staging
Worker: ourhostself-ourtunnelself-staging
URL: https://ourhostself-ourtunnelself-staging.situatedsolutions.workers.dev
Cloudflare version: e8946bc3-9634-474d-a19f-47644c07c90c
Source branch: architecture/ourhostself-cloudflare-workers-do-v0.1
Source commit at deployment: 193dc7446a60f7476c9845e2f4cee59d70a6a1a1
Wrangler: 4.168.0

## Deployment and live readback

- Wrangler upload and deployment succeeded.
- Binding OURHOSTSELF_STATE → OURHOSTSELFState is present.
- GET /health returned HTTP 200.
- Health reports authority NONE_BY_TRANSPORT.
- Health reports trust_configuration MISSING, with the exact missing Seat/PORTAL key and issuer fields.
- Health reports trust_chain_validation NOT_IMPLEMENTED and delivery_key_certification NOT_IMPLEMENTED.
- Health reports delivery_signing_key MISSING.
- GET /v1/seat/devices returned HTTP 503 TRUST_CONFIGURATION_REQUIRED.
- POST /v1/device/poll returned HTTP 503 TRUST_CONFIGURATION_REQUIRED.
- A temporary staging-only structural trust document was accepted by Wrangler. After propagation, health reported PRESENT_UNVERIFIED and the protected Seat route returned HTTP 503 OSOS_TRUST_CHAIN_UNVERIFIED.
- The temporary secret was deleted. Post-cleanup health returned MISSING and Wrangler secret list returned an empty array. No staging trust secret or delivery signer remains installed.
- The accessible OURSYSTEMSELFOPERATIN repository contains only README.md; no OSOS root/subordinate certificate-chain schema was found. The existing PIPE|PORTAL audit records that issuer keys and the delivery key are not certified/pinned through an approved OSOS trust chain.

## Local verification

- 16 Worker/trust/witness/SQLite tests passed.
- 8 existing OURTUNNELSELF broker regression tests passed.
- Wrangler dry-run passed and recognized the Durable Object binding.
- The local SQLite close/reopen test now also proves that the persisted probe record survives while the in-memory instance boot ID changes.
- A token-gated staging-only `/__staging/state-self-check` route was added for remote Durable Object SQLite read/write and instance-boot-ID verification. It is inaccessible unless a temporary staging-only secret is present; the token must be deleted immediately after the probe.
- Cloudflare Containers discovery returned an account entitlement error: deploying containers requires the Workers Paid plan. No plan upgrade or charge was authorized.

## Local verification (prior receipt)

- 15 Worker/trust/witness/SQLite tests passed.
- 8 existing OURTUNNELSELF broker regression tests passed.
- Node syntax checks passed, including the device agent.
- Wrangler dry-run passed and recognized the Durable Object binding.
- Node SQLite lifecycle test passed: initial read, device enrollment write, nonce replay rejection, job claim, result/evidence commit, revocation, and close/reopen persistence.

## Boundaries

The SQLite lifecycle test exercises the Durable Object class against Node's SQLite implementation; it is not a Cloudflare workerd or remote Durable Object runtime test. The staging deployment proves the current Worker version is live and fail-closed, not that signed Seat/PORTAL/device traffic is admitted or that the device agent completes an end-to-end job. A structurally valid secret remains PRESENT_UNVERIFIED until OSOS root/subordinate certification and issuer-policy binding are implemented. The inspected OSOS repository contains only README.md; the authoritative chain schema is not yet present in the accessible source.

No production hostname, production tunnel, existing Mac-side origin, or Pipe|Portal process was modified. No device was admitted. No command execution was enabled. The Worker-signed evidence receipt is not an independent witness and is not canonical DATASELF custody. RAWMAC power-off independence remains unproven.
