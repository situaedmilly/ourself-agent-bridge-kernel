# DEVICESELF + WITNESSSELF v0.1

## Device lifecycle

- Enrollment endpoint: POST /v1/seat/devices/enroll
- Revocation endpoint: POST /v1/seat/devices/{device_id}/revoke
- Inventory endpoint: GET /v1/seat/devices
- Device identity: Ed25519 SPKI public key; private key remains on the device.
- Enrollment requires Seat scope ourself:device:enroll and a separate signed PORTAL ADMIT token with capability device.enroll.
- Revocation requires Seat scope ourself:device:revoke and a separate signed PORTAL ADMIT token with capability device.revoke.
- A device is enabled only after both checks pass. Revocation disables it immediately and records an append-only event.
- Portal decision JTI values are consumed once in the Durable Object transaction.

## Authenticated device transport

- Poll: POST /v1/device/poll with an empty body.
- Result: POST /v1/device/result with canonical JSON.
- Headers: x-ourself-device, x-ourself-timestamp, x-ourself-nonce, x-ourself-signature.
- The Ed25519 signature binds timestamp, nonce, and SHA-256 of the exact request body.
- Timestamp tolerance is 60 seconds. Nonces are consumed atomically in SQLite and retained until expiry.
- Revoked or disabled devices cannot obtain credentials, poll, or submit results.

## Delivery envelope

Worker secret OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM is an Ed25519 PKCS#8 private key. It is distinct from Seat/PORTAL trust configuration and must never be committed. Its matching public key must be provisioned to device agents as their broker verification key.

Delivery envelopes use RFC 8785-compatible sorted-key JSON, domain separation string OURSELF-PIPE-PORTAL-COMMAND-JCS-RFC8785-V1, SHA-256 digest, and Ed25519 signature. The payload carries the original short-lived PORTAL admission and its authority/policy references. A claim transition is committed before the envelope is returned, preventing concurrent duplicate claims.

## Result outbox and DATASELF evidence

The device agent journals a pending result before attempting delivery. It retries pending results after transient failures and after restart. The Worker accepts an identical completed result idempotently, but rejects a different result for the same job.

The Worker constructs a signed evidence receipt binding:
- job and device identifiers
- exact result digest
- device timestamp, nonce, and request signature
- PORTAL decision JTI
- authority grant reference and policy version
- receipt timestamp

Result state, result digest, signed receipt, and DATASELF_EVIDENCE_RECEIPT event are committed in one Durable Object SQLite transaction. The caller's job readback includes the receipt when present.

**Witness boundary:** the current receipt is signed by the same Worker key that signs delivery envelopes and stored by the same Durable Object. This is a provenance receipt, not an independent witness. It cannot independently attest to the Worker, device, or claimed effect. No WITNESSED or REALISELF state is emitted. A separate witness service/trust domain and independent effect readback remain unimplemented.

**DATASELF boundary:** the Durable Object stores a receipt record and append-only event; it is not yet connected to the canonical DATASELF custody/adapter contract. Do not treat this as canonical DATASELF replication or independent custody.

## Required secrets and provisioning

- TRUST_CONFIGURATION_OURSELFECOSYSTEM: canonical Seat and PORTAL public-key/issuer/audience configuration.
- OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM: Ed25519 delivery/evidence signing private key.
- The matching delivery public key must be installed on each authorized device as OURTUNNELSELF_BROKER_PUBLIC_KEY.
- Never use staging keys or issuer identifiers as production trust.
- Device enrollment is not production-ready until actual OSOS and PORTAL issuer authority and key custody are established.
- A Worker-signed receipt is not independent WITNESSSELF; a separate witness trust domain and effect readback remain required.

## Limits / non-claims

The Worker routes and state transitions are implemented in this branch, but all authority-bearing routes intentionally remain blocked until the OSOS root/subordinate trust chain and Seat/PORTAL issuer profile are cryptographically validated. A well-formed configuration secret is PRESENT_UNVERIFIED, not authority. Production device execution is not admitted. A Node SQLite compatibility test exercises the Durable Object class SQL, enrollment, nonce replay, job claim, result/evidence transaction, revocation, and close/reopen persistence. This is stronger than a mock but is not a Cloudflare workerd/remote Durable Object runtime test. The full signed device-agent-to-Worker path, Cloudflare SQLite behavior, and actual signed Seat/PORTAL admission still require an isolated integration test. A successful unit test or Wrangler dry-run does not establish those runtime properties.

No broad shell execution is implemented. The existing repo.status / git_status operation remains the only permitted capability.
