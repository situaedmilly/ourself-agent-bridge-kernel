# PIPE|PORTAL · Fresh Boot Reality Audit v0.1

**Scope:** Read-only source audit of the OURTUNNELSELF broker and device agent on `architecture/ourself-desktop-commander-tunnel-v0.1`.
**Audit date:** 2026-11-25
**Authority:** None. This document records source observations and does not admit a host, issue an OSOS grant, or authorize execution.
**Execution status:** No live PIPE|PORTAL round trip or target-device session was performed during this audit.

## 1. CHAMBOXREALITY boundary

The inspected implementation currently provides a narrow remote job path:
- Seat-authenticated broker access.
- Separately signed PORTAL admission.
- An enabled device-registry record.
- Device-authenticated outbound polling.
- Broker-signed job envelope.
- A local OURSELFD Unix-socket request for `repo.status` / `git_status`.
- Device-signed result submission and broker journal persistence.

This is a narrow read-only repository-status path. It is not a general remote shell, arbitrary filesystem interface, DATASELF storage interface, or GENESIS authority actuator.

## 2. Verified source facts

### Broker (`runtime/ourtunnelself/broker.js`)
- Uses RS256 JWT verification for seat and PORTAL tokens.
- Requires seat issuer/audience and PORTAL issuer/audience configuration.
- Requires an enabled device entry in the external device registry.
- Requires PORTAL decision `ADMIT`, caller binding, target-device binding, admitted capability, authority grant reference, policy version, and `jti`.
- Restricts implemented capability to `repo.status` and operation to `git_status`.
- Restricts target to `.`.
- Signs broker job envelopes with RSA-SHA256.
- Journals requested jobs, device nonces, delivery events, and completion events with file sync.
- Binds the broker listener to loopback by default.
- Exposes an unauthenticated `/health` response. That response is a process-health hint only; it is not proof of trust, device connectivity, authority, or end-to-end execution.
- Has no independent witness signing or verification integration in the inspected source.

### Device agent (`runtime/ourtunnelself/device-agent.js`)
- Requires HTTPS for broker communication unless an explicit insecure override is enabled.
- Signs device poll/result requests using a device private key, timestamp, nonce, and SHA-256 of the raw request body.
- Verifies the broker's RSA-SHA256 envelope signature and independently verifies the embedded PORTAL JWT.
- Checks PORTAL issuer, audience, expiry, caller, device, capability, authority reference, and policy version.
- Restricts execution to `repo.status` / `git_status` with target `.`.
- Calls OURSELFD through a local Unix socket.
- Maintains a local append-only job journal and suppresses job IDs already recorded there.
- Does not expose arbitrary shell execution in the inspected implementation.

## 3. Blocking findings

### B1 — No byte-for-byte payload commitment

The broker signs a JSON serialization of a JavaScript object. The device verifies a serialization of the parsed object. The current envelope does not carry and verify a separately specified canonical payload byte string and its SHA-256 digest.

**Consequence:** The implementation demonstrates signed semantic JSON payload handling, not a complete byte-for-byte command commitment across all serialization boundaries.

**Required correction:** Define one canonical encoding and domain-separated digest for the exact command bytes. Include the digest, encoding identifier, and byte length in the signed envelope. Verify the received bytes before parsing or execution. Reject duplicate JSON member names and noncanonical encodings.

### B2 — Cryptographic algorithm profile is not reconciled with OSOS trust contract

The OSOS bounded trust specification selects Ed25519 for root/subordinate authority signatures. The current broker and PORTAL integration use RSA/RS256.

**Consequence:** The inspected source does not establish a verified chain from the OSOS Ed25519 trust root to the broker's RSA signing identity or the PORTAL RSA issuer.

**Required correction:** Either implement the agreed Ed25519 profile end-to-end, or document and cryptographically bind an explicitly approved algorithm-transition/cross-signing policy. No silent algorithm substitution.

### B3 — Independent witness absent

The broker journals request/delivery/completion events but does not obtain an independent witness signature over a command digest, authority decision digest, target receipt, and readback digest.

**Consequence:** Broker persistence is not independent witnessing.

**Required correction:** Add an independent witness verification/signature stage in a separate failure and administrative domain. A broker-generated receipt cannot self-witness.

### B4 — Result is not equivalent to verified effect

The device submits a signed result containing an OURSELFD local receipt. The broker stores the result. The inspected broker does not independently re-contact the target and verify resulting state.

**Consequence:** `COMPLETED` is a broker workflow status, not proof that the requested effect was independently read back.

**Required correction:** Separate `RECEIVED`, `AUTHENTICATED`, `AUTHORIZED`, `ADMITTED`, `EXECUTED`, `READBACK_VERIFIED`, and `WITNESSED`. Only issue the latter states after their corresponding evidence exists.

### B5 — No production endpoint or admitted target proven by source inspection

Source configuration and example registry files do not prove a deployed gateway, active PORTAL issuer, enrolled Pi agent, live session, or currently reachable endpoint.

**Required correction:** Obtain live, nonce-bound handshake evidence through the designated PIPE|PORTAL route and verify the target device identity against its independently pinned enrollment record.

## 4. Fresh boot gate sequence

| Gate | Required evidence | Pass condition |
|---|---|---|
| BOOT-001 | PIPE|PORTAL session challenge/response | Nonce, session, endpoint identity, and exact command digest verified |
| BOOT-002 | Broker identity and runtime readback | Pinned broker key, host identity, boot ID, and runtime instance match |
| BOOT-003 | OSOS authority chain | Valid root/subordinate chain, exact audience, action, resource, expiry, revocation epoch |
| BOOT-004 | Device admission | Device key, registry state, target identity, and boot identity verified |
| BOOT-005 | DATASELF discovery | Read-only storage inventory and canonical-store registration facts returned |
| BOOT-006 | Independent witness | Witness signs the exact evidence bundle from an independent trust domain |
| BOOT-007 | Reality reconciliation | Every claim classified as current verified, historical, inferred, blocked, or not established |

No write operation is permitted as part of BOOT-001 through BOOT-007.

## 5. Invariants

- Declaration is not authority.
- Transport receipt is not execution.
- Execution receipt is not independently verified effect.
- Broker persistence is not independent custody.
- Cryptographic provenance is not truth.
- Replay is not re-execution.
- A signed PORTAL admission is not an OSOS grant unless its authority reference resolves to a valid OSOS decision.
- A device registry entry is not proof that the device is online.
- A process-health endpoint is not proof of a trusted boot.

## 6. Disposition

**Current code disposition:** Source contains a useful, narrowly scoped outbound device-agent and broker foundation. It is not yet a byte-for-byte verified PIPE|PORTAL production execution plane.

**Permitted next action:** Implement B1-B4 as separately tested changes, preserving the current read-only capability. Then run unit, integration, replay, crash-recovery, and independent-witness tests before any production deployment or authority binding.

**Prohibited inference:** This audit does not claim that PIPE|PORTAL is unavailable in the wider OURSELF ecosystem. It only records that this repository's inspected broker/device-agent source and the current ChatGPT-connected tool surface did not provide a live round-trip proof during this session.
