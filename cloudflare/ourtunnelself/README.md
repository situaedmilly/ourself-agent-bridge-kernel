# OURHOSTSELF · Cloudflare Workers + Durable Objects prototype

This isolated migration slice does not replace the Node broker, change existing tunnel configurations, or claim production admission.

## Verification without paid GitHub Actions

GitHub is source custody and review—not our compute plane. No GitHub Actions workflow is required or included.

From the repository root, run:

```sh
bash cloudflare/ourtunnelself/scripts/verify-local.sh
```

The script uses the local Node.js runtime to syntax-check the Worker, run its contract tests, and run the existing OURTUNNELSELF regression tests. If Wrangler is installed locally, it also performs a Wrangler dry-run build. If Wrangler is absent, the script reports that build validation was skipped; it does not deploy.

This script can be invoked by a macOS Shortcut or another OURSELF-controlled local orchestrator. Its result is local execution evidence, not production admission.

## Deploy configuration

Deployment is a separate, explicitly authorized operation. From this directory, use Wrangler with the authorized Cloudflare account:

```sh
npx wrangler deploy
```

Configure trust values as Wrangler secrets; never commit private keys or tokens:

```sh
npx wrangler secret put OSOS_SEAT_PUBLIC_KEY_PEM
npx wrangler secret put OSOS_PORTAL_PUBLIC_KEY_PEM
npx wrangler secret put OURHOSTSELF_SEAT_ISSUER
npx wrangler secret put OURHOSTSELF_PORTAL_ISSUER
```

Optional audience values default to `ourtunnelself`.

## Implemented in this slice

- Worker ingress and a transport-only `/health` endpoint.
- RS256 seat and PORTAL JWT verification using Web Crypto.
- Issuer, audience, expiry, subject, scope, caller, target-device, and capability checks.
- SQLite-backed Durable Object tables for devices, events, jobs, and replay nonces.
- Atomic one-time PORTAL decision consumption when admitting a job.
- Caller-bound job readback.
- Restriction to the existing read-only `repo.status/git_status` capability.

## Explicitly not implemented

- Device registry enrollment and revocation administration.
- Device polling/result routes and Ed25519 device request authentication.
- Ed25519 broker delivery-envelope signing.
- Nonce consumption on device requests.
- Job delivery state machine, uncertain-delivery recovery, and event replay.
- MCP Streamable HTTP adapter.
- R2 evidence archive integration.
- OSOS signer/key rotation, PORTAL issuance, independent witness, and DATASELF receipts.
- Worker runtime integration tests, staging deployment, custom-domain binding, and real-device end-to-end validation.

The registry starts empty, so requests are denied until a separately governed enrollment mechanism is implemented. No device command can execute through this slice. A 200 response from `/health` proves transport liveness only, not authority, admission, or production readiness.
