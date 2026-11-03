# PIPE|PORTAL Host Administration Execution Path v0.1

Status: MANIFESTED CONTRACT · NOT IMPLEMENTED · NOT DEPLOYED · FAIL-CLOSED
Date: 2026-11-03
Owning reality: OURSELFECOSYSTEM / OURHARDWARESELFS / INTERCONNECTION
Target substrate for first workload: OURSELFPIMAC
First bounded workload: C10 independent witness provisioning for ALTONUMBUSELF

## 1. Purpose

Establish an approved, auditable path for narrowly scoped host-administration operations that cannot be performed through the current restricted execution seat. This path exists to provision the dedicated C10 witness identity, certificate, isolated service, and read-only subject-observation capability on OURSELFPIMAC.

This is not a general remote shell, terminal proxy, privilege-escalation endpoint, or replacement for operating-system security. It is a typed operation broker with explicit admission, local enforcement, host-local administrator enrollment, and independent verification.

## 2. Current preimage

Observed on 2026-11-03:

- AetherBridge PIPE|PORTAL v0.2 is boot-active on OURSELFMAC at 127.0.0.1:49320.
- Its mapped API routes fail closed because the independent certifier root and signed INPUTSELFTRUSTSELF bundle are not provisioned.
- AetherBridge is loopback-bound. It is not a network-reachable host-administration gateway.
- OURSELFPIMAC is a distinct physical host at the time of observation; its observed LAN address 10.0.0.108 is a locator, not a durable identity.
- SELFSERVER-2 owns 127.0.0.1:8765. It is loopback-only and must remain untouched.
- The current SELFSERVER-2 HTTP handler has no C10 witness role and no host-administration capability.
- Existing Agent Bridge terminal tooling is RUORA-bound and is not a valid host-admin executor for OURSELFPIMAC.
- Desktop Commander command policy blocked the attempted privileged provisioning path. No bypass is authorized or designed here.

These observations are not hardware attestation. Registry states remain DISCOVERED until the canonical identity and jurisdiction evidence is independently admitted.

## 3. Topology

```text
Founder / authorized operator
          |
          v
AETHERBRIDGE PORTAL (OURSELFMAC, loopback)
  identity + jurisdiction + authority + capability admission
          |
          v
PIPE dispatch adapter (OURSELFMAC, outbound mTLS)
  signed, correlated, replay-bounded operation envelope
          |
          v
OURSELFPIMAC witness ingress (unprivileged, dedicated runtime)
  mTLS peer authentication + PORTAL signature verification
          |
          v
local Unix-domain socket
          |
          v
root-owned OURSELF Host Admin Broker
  fixed operation catalog only; no shell; no arbitrary argv/path
          |
          v
OS-enforced fixed installers / systemd unit management
          |
          v
isolated ourself-c10-witness service (unprivileged)
          |
          v
independent GitHub subject read + local SHA-256
          |
          v
durable witness evidence + independent recontact
```

PIPE carries requests and evidence. PORTAL admits exact operations. The Pi's operating system remains the final local enforcement authority. The witness service is a separate workload and does not share SELFSERVER-2's process, files, credentials, listener, or execution authority.

## 4. Authority separation

| Domain | Owns | Must not |
|---|---|---|
| Founder / operator | Explicit task authority and scope | Replace local OS enforcement |
| OURHARDWARESELFS | Host identity, jurisdiction, binding and evidence records | Infer identity from IP or hostname alone |
| PORTAL | Signed, short-lived, operation-specific admission | Grant root or kernel authority |
| PIPE | Authenticated transport, correlation, replay bounds | Widen capabilities or alter requests |
| Pi ingress agent | Verify transport and envelope; submit typed request | Execute privileged work or accept shell text |
| Host Admin Broker | Fixed privileged operation dispatch | Accept arbitrary commands, scripts, paths or packages |
| OS / systemd | Local process, filesystem and service enforcement | Trust a PIPE connection as authorization |
| C10 witness | Independently fetch and hash the exact subject | Trust a primary-supplied digest as its observation |

Required distinctions:

- PIPE_CONNECTION != PORTAL_ADMISSION
- PORTAL_ADMISSION != LOCAL_OS_AUTHORIZATION
- LOCAL_OS_AUTHORIZATION != EXECUTION
- EXECUTION != VERIFIED_EFFECT
- CERTIFICATE_PRESENT != IDENTITY_ATTESTED
- WITNESS_SERVICE_RUNNING != C10_VERIFIED
- C10_VERIFIED != MIGRATION_GATE_OPEN
- C10_VERIFIED != REALISELF

## 5. Operation catalog

Only these operation IDs are in the initial C10 profile:

| Operation ID | Effect class | Purpose |
|---|---|---|
| c10.witness.preflight | READ_ONLY | Check host, platform, package prerequisites, service-name conflicts, and fixed paths |
| c10.witness.identity.generate | HOST_MUTATION | Generate witness private key locally; key never leaves OURSELFPIMAC |
| c10.witness.csr.export | READ_ONLY | Export only the public CSR and its digest for independent certification |
| c10.witness.certificate.install | HOST_MUTATION | Install a certifier-signed witness certificate and public chain at fixed paths |
| c10.witness.service.install | HOST_MUTATION | Install the reviewed, digest-pinned witness service and systemd unit |
| c10.witness.service.start | PROCESS_EXECUTION | Start the dedicated unprivileged witness service |
| c10.witness.service.status | READ_ONLY | Observe unit state, listener, process identity, and version |
| c10.witness.subject.observe | READ_ONLY_EXTERNAL_IO | Fetch the exact pinned public/private GitHub subject using a separately scoped read-only identity; independently compute SHA-256 |
| c10.witness.evidence.export | READ_ONLY | Export signed observation and transport metadata; never export private key material |

The broker MUST reject any operation ID not in the installed catalog. The request schema contains no shell, command, executable, arbitrary path, environment, script, package URL, or free-form argument field.

## 6. Authentication and trust

Three cryptographic roles are separate:

1. Independent certifier root: signs the INPUTSELFTRUSTSELF bundle and endpoint certificates. Its private key is offline or held by an independently governed signing system; it is not stored in either endpoint runtime.
2. PORTAL decision issuer: signs the short-lived operation admission. It is distinct from the certifier root and both endpoint identities.
3. Endpoint identities: distinct primary OURSELFMAC and witness OURSELFPIMAC keypairs and certificates. Each private key is generated and retained on its own host.

The transport uses TLS 1.3 mutual authentication. The signed PORTAL envelope is independently verified at both the Pi ingress agent and the privileged broker. Certificate subject, SAN, issuer, key ID, validity, revocation state, and exact endpoint identity references must match the trust bundle and hardware registry.

Do not reuse OURSELFD CREATE_LOCAL_WITNESS issuer, OURSELF-ED25519-002, an existing Secure Enclave signer, GitHub user credentials, or a model/session identity as a PORTAL signer or witness identity.

The primary and witness endpoints must have distinct authenticated identity references, channel IDs, runtime IDs, and host IDs. The witness must retrieve the exact subject itself. The primary may supply the locator and expected commit, but its digest is a comparison value only.

## 7. Request and admission controls

Every request binds:

- request_id and idempotency_key;
- source and target identity references;
- exact operation_id and capability;
- immutable workload profile/version and artifact digests;
- fixed target service/path identifiers from the installed catalog;
- purpose, evidence references, nonce, issued_at and expires_at;
- authority_grant_ref and policy_version.

Admission requirements:

- Exact source OURSELFMAC and target OURSELFPIMAC identities are registered and verified.
- Source and target jurisdiction and binding are independently evidenced.
- A signed, unexpired INPUTSELFTRUSTSELF bundle is valid and registry digests match.
- A signed PORTAL decision admits the exact operation capability and target.
- Maximum decision TTL is five minutes; nonce is one-use; replay and duplicate idempotency are rejected.
- The requested operation is in the local allowlist and matches its exact input schema.
- The Pi local broker independently verifies the PORTAL decision and local policy.
- Host mutation operations require the pre-enrolled local administrator policy. Initial broker installation requires an administrator-authenticated bootstrap on the Pi itself.
- Missing, stale, conflicting, revoked, or unverifiable evidence means DENY or QUARANTINE.

A founder instruction in ChatGPT is task authority for this bounded work. It is not a substitute for Linux administrator authentication, a signed PORTAL decision, or a local OS authorization.

## 8. Privileged broker design

The privileged component is a root-owned, fixed-purpose broker exposed only through a Unix-domain socket with restrictive ownership and mode. It verifies caller UID/GID using peer credentials, validates the signed request again, checks nonce/replay state, enforces action-specific local policy, and invokes only compiled-in operation handlers.

The broker MUST:

- never invoke a shell;
- never accept arbitrary executable names, arguments, paths, environment variables, or package URLs;
- use fixed, root-owned source artifacts pinned by SHA-256;
- use atomic file installation, restrictive ownership/modes, fsync, and post-write readback;
- refuse symlinks, path traversal, unexpected existing files, and unapproved unit replacement;
- keep witness private keys outside the broker's read/export surface;
- run the witness service as a dedicated unprivileged account with filesystem and network restrictions;
- maintain append-only, hash-chained operation receipts;
- support explicit stop/rollback operations with their own admission;
- leave SELFSERVER-2 and its port 8765, files, process, and configuration untouched.

The broker is not a generic sudo wrapper, command runner, SSH shell, or remote root daemon.

## 9. First workload: C10 witness

Pinned subject:

- repository: situaedmilly/ALTONUMBUSELF
- branch: morph-xi/selfmoat-proving
- commit: 3fdde73c099f9b99814d72dc224c638965be27e9
- path: evidence/morph-xiii/FINAL-PROOF-001.json
- expected SHA-256: 22a4228da535aab04fb653b19f07d71fc81d3305fc9a0db398a2e6acfc717c5f

The witness runtime independently resolves the exact commit and path from GitHub, retrieves the bytes, computes SHA-256 locally, and records commit identity, Git blob identity, byte count, retrieval endpoint, authenticated witness identity, channel ID, runtime ID, host ID, timestamp, and evidence digest.

For a private repository, use a separate GitHub App installation identity restricted to contents:read for this repository and branch/subject. Do not reuse the primary session's token. If a separately scoped credential cannot be provisioned, the witness remains BLOCKED.

The witness service emits evidence only. It cannot modify the repository, branch, migration gate, C10 state, or REALISELF state.

## 10. Receipt lifecycle

Keep these events distinct:

1. HOST_ADMIN_REQUEST_RECEIVED
2. PORTAL_ADMISSION_VERIFIED
3. PIPE_PEER_AUTHENTICATED
4. LOCAL_POLICY_AUTHORIZED
5. OPERATION_DISPATCHED
6. OPERATION_COMPLETED or OPERATION_FAILED
7. POSTCONDITION_OBSERVED
8. INDEPENDENT_RECONTACT_COMPLETED

Each receipt binds request_id, decision_id, operation_id, source/target identities, artifact digests, timestamps, exit/result classification, and verification evidence. Receipts must not contain private keys, access tokens, CSR private material, or credential values.

A successful request receipt does not prove a service is running. A running service does not prove it observed the pinned subject. A matching digest does not prove C10 unless all identity, channel, runtime, host, and evidence predicates pass.

## 11. Rollback and failure behavior

- Admission failure: no dispatch; preserve denial receipt.
- Transport/authentication failure: no dispatch; close channel; preserve failure metadata.
- Local OS denial: no privileged operation; return BLOCKED.
- Partial install: stop service if started, preserve original files, restore only from a verified preimage under a separately admitted rollback operation.
- Unexpected existing unit/path/package: quarantine; do not overwrite.
- Service health failure: keep C10 BLOCKED; no automatic retry.
- Digest mismatch: REFUSED; preserve both observations.
- Witness identity or endpoint distinction unresolved: BLOCKED.
- Rollback never deletes evidence or rewrites historical terminal proofs.

## 12. Implementation sequence

1. MANIFEST: this architecture, request schema, operation catalog, and OpenAPI contract.
2. VALIDATE: schema, operation allowlist, signature envelope, replay rules, and negative tests.
3. ESTABLISH TRUST: independent certifier root, distinct PORTAL signer, endpoint identity records, signed trust bundle, revocation policy.
4. BOOTSTRAP PI: local administrator authenticates one-time installation of the fixed broker and unprivileged ingress/service accounts. No remote privilege escalation.
5. MATERIALIZE PIPE: outbound mTLS channel from the Mac dispatch adapter to the Pi ingress agent; no public AetherBridge listener.
6. MATERIALIZE PORTAL: exact route-to-capability map and signed one-use decisions; current AetherBridge v0.2 remains fail-closed until trust is valid.
7. PREFLIGHT: run c10.witness.preflight and independently inspect its result.
8. PROVISION: generate key on Pi, export CSR only, obtain independent certificate, install certificate, install/start isolated service through separately admitted operations.
9. VERIFY: independently inspect process, unit, listener, file modes, certificate chain, and service identity.
10. WITNESS: fetch and hash the pinned subject from the witness host; run the existing C10 evaluator.
11. RECONTACT: independently retrieve the witness evidence and verify its digest and endpoint distinctions.

No phase auto-promotes the next. Every operation is separately admitted.

## 13. Current disposition

MANIFESTED: architecture and contract artifacts in this directory.
IMPLEMENTED: no host-admin broker, ingress agent, route, or service implementation is claimed.
DEPLOYED: false.
CERTIFIER ROOT: not provisioned.
PORTAL TRUST BUNDLE: not provisioned; current AetherBridge v0.2 remains fail-closed.
PRIMARY ENDPOINT CERTIFICATE: not provisioned.
WITNESS ENDPOINT CERTIFICATE: not provisioned.
PI LOCAL ADMIN BOOTSTRAP: not performed.
PIPE mTLS: not established.
C10: BLOCKED.
MIGRATION_GATE: CLOSED.
REALISELF: FALSE.

This manifest defines the admissible path. It does not itself install privileged components, issue certificates, open network ingress, or grant kernel authority.
