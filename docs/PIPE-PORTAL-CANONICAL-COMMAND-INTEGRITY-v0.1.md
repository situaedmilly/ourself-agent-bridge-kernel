# PIPE|PORTAL · Canonical Command Integrity Implementation v0.1

**Branch:** `architecture/ourself-desktop-commander-tunnel-v0.1`
**Date:** 2026-11-25
**Scope:** Narrow read-only OURTUNNELSELF command path.
**Authority:** This implementation does not create OSOS authority, admit a device, or establish a production endpoint.

## Implemented

### Canonical command representation
`runtime/ourtunnelself/command-integrity.js` implements the OSOS-required RFC 8785 JSON Canonicalization Scheme (JCS) as `OURSELF-JCS-RFC8785-V1`:
- UTF-8 JCS bytes.
- Object keys recursively sorted by UTF-16 code units as required by RFC 8785.
- Array order preserved.
- String and number serialization follows ECMAScript JSON serialization required by JCS; invalid Unicode scalar sequences and non-finite numbers are rejected.
- Rejects non-finite numbers, undefined values, sparse arrays, accessors, non-plain objects, and unsupported values.
- Strict UTF-8 decoding.
- Ingress parser compares the received byte string with the canonical serialization. This rejects whitespace/key-order variants and duplicate object member names because their raw representation cannot equal the normalized canonical representation.
- Command digest is SHA-256 over the domain prefix `OURSELF-PIPE-PORTAL-COMMAND-V1\0` followed by the exact canonical payload bytes.

### Broker enforcement
- The broker serializes each job payload using RFC 8785 JCS before signing with Ed25519.
- The broker envelope includes encoding identifier, canonical byte length, domain-separated digest, and signature.
- The broker requires canonical JSON bytes for HTTP seat command requests and device result submissions.
- Duplicate JSON members and noncanonical command bytes are rejected before the command is accepted or a result is recorded.

### Device-agent enforcement
- The device agent reconstructs the canonical payload bytes and verifies the broker Ed25519 signature.
- It checks encoding identifier, byte length, and digest.
- It verifies the broker signature over those exact canonical bytes before validating PORTAL admission and the narrow capability.
- Device result submissions use canonical JSON serialization.

### Tests added
- Deterministic object key ordering and preserved array order.
- Rejection of whitespace/key-order variants and duplicate JSON members.
- Domain-separated digest and byte-length verification.
- Rejection of ambiguous/unsupported JavaScript values.
- Broker integration assertions for signed canonical payload, digest, byte length, signature verification, tamper rejection, and duplicate-member rejection.

## Verification record

### Local test execution
The canonical-integrity module and its four focused tests were copied from the committed source into an isolated Node.js 22.16.0 scratch directory and executed with `node --test`.

Result: **4 passed, 0 failed**.

An additional local Ed25519 check generated an ephemeral test-only keypair, signed canonical command bytes, verified the signature and digest, and rejected a modified payload. The ephemeral keypair was not persisted or used as production trust material.\n\nThese checks validate the canonical-integrity utility and Ed25519 primitive behavior only. They do not substitute for running the broker integration test or device-agent runtime.

### GitHub Actions
The repository workflow was updated to syntax-check the new module and execute both command-integrity and broker integration tests.

The latest observed workflow run for commit `81b485b9317603fb13397c654128eed34c91c127` failed before job execution:
- Job status: completed / failure.
- Runner ID: `0`.
- Runner name: empty.
- Steps: empty.
- Logs: unavailable.

The same pre-runner failure pattern occurred on earlier pushes. This is an execution-environment/runner availability blocker; it is not evidence that the tests passed or failed in a runner.

## Remaining blockers

1. **Trust-profile reconciliation:** seat and PORTAL JWT verification still use RSA/RS256, while broker delivery envelopes now use Ed25519. The OSOS production trust specification selects Ed25519 for its root/subordinate authority signatures. The broker public key is not yet certified or pinned through that OSOS trust chain, and seat/PORTAL issuer keys are not yet bound to an approved OSOS trust policy. Do not silently substitute issuer keys or generate production authority.
2. **Independent witness:** no separate witness service currently signs the command digest, authority decision digest, target receipt, and readback digest.
3. **Independent effect readback:** broker completion still records a submitted device result; it does not independently re-contact the target and verify resulting state.
4. **Live route:** no fresh PIPE|PORTAL challenge/response, broker identity readback, or Pi device handshake was captured in this execution.
5. **Runtime test gate:** GitHub Actions has not assigned a runner, so the broker integration test and full CI syntax/test suite remain unexecuted.

## Disposition

**B1 — canonical command-byte commitment:** implementation added; focused utility tests pass locally. Broker/device integration remains pending runner-backed test evidence.

**Production boot:** NOT ESTABLISHED.

No production key generation, device admission, storage mutation, remote shell, or authority elevation was performed.
