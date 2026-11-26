# OURHOSTSELF · Staging Deployment Receipt

Date: 2026-11-26 UTC
Environment: isolated Cloudflare Workers staging deployment
Worker: `ourhostself-ourtunnelself-staging`
URL: https://ourhostself-ourtunnelself-staging.situatedsolutions.workers.dev
Cloudflare Worker version: `2bf7e8b8-ccde-4d30-b500-161cda6b6c55`
Source branch: `architecture/ourhostself-cloudflare-workers-do-v0.1`
Source commit: `7ef010a8aa346e4bb52f75fb02a4407b5fde7157`
Wrangler: `4.168.0`

## Deployment evidence

- Wrangler authenticated successfully to the authorized Cloudflare account.
- Worker upload and deployment completed successfully.
- Durable Object binding `OURHOSTSELF_STATE` / class `OURHOSTSELFState` was included in the deployed configuration.
- HTTPS health request returned HTTP 200:
  `{"service":"OURHOSTSELF","state":"READY","authority":"NONE_BY_TRANSPORT","persistence":"DURABLE_OBJECT_SQLITE"}`
- Protected device-list route returned HTTP 503 with `TRUST_CONFIGURATION_REQUIRED`, confirming fail-closed behavior when trust material is absent.
- Unknown route returned HTTP 404 with `NOT_FOUND`.
- Wrangler deployment inventory reported version `2bf7e8b8-ccde-4d30-b500-161cda6b6c55` at 100%.

## Boundaries

- This is a staging Worker on the workers.dev hostname only.
- No production hostname, DNS route, or existing tunnel was changed.
- No signing keys, issuers, or PORTAL trust secrets were configured.
- No device was enrolled and no device command was admitted or executed.
- HTTP 200 proves Worker transport health, not authority, device admission, or Durable Object transaction/recovery correctness.
- Durable Object binding is deployed, but runtime state mutation, persistence across restart, replay, and recovery still require dedicated tests.
- Mac-offline independence is not yet established: existing production tunnels still have Mac-side connectors/origins, and the OURHOSTSELF-INGRESS tunnel still has zero connectors.

## Pre-deployment verification

- Worker contract tests: 3 passed.
- Existing OURTUNNELSELF regression tests: 8 passed.
- Node syntax checks: passed.
- Wrangler dry-run: passed.
- Shortcut wrapper invocation: passed.

## Next gates

1. Exercise Durable Object state in an isolated test path and verify persistence/restart semantics.
2. Implement authenticated device enrollment/revocation and device poll/result.
3. Implement signed delivery envelopes and replay/nonce enforcement.
4. Integrate witness and DATASELF evidence receipts.
5. Run staging end-to-end tests from a non-Mac compute node.
6. Establish independent host/connector and prove health with RAWMAC powered off.
7. Only then consider production ingress migration with rollback.

