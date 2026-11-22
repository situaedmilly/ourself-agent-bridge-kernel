# OURSELF DESKTOP COMMANDER + OURTUNNELSELF
## Provider-Independent Remote Execution Architecture v0.1

Status: IMPLEMENTATION SPECIFICATION / NOT YET DEPLOYED
Branch: architecture/ourself-desktop-commander-tunnel-v0.1
Authority domains: OSOS, OURTUNNELSELF, OURHARDWARESELFS, PORTAL, PIPE, AGENTBRIDGE, OURSELFd, MODELSELFWITNESS, DATASELF

## 1. Purpose

Provide an OURSELF-owned remote execution pathway from an authorized ChatGPT seat or other authorized operator seat to a registered OURSELF device, without requiring Desktop Commander or any other commercial desktop-control provider.

The product is OURSELF DESKTOP COMMANDER. OURTUNNELSELF supplies the provider-independent transport and session architecture. PIPE carries messages. PORTAL evaluates passage. The target device's local OURSELFd runtime and OS policy enforce each operation.

This is not a remote unrestricted shell. It is a governed, typed capability execution system.

## 2. Governing topology

Authorized seat
  -> OURSELF MCP / command gateway
  -> OSOS caller identity and scoped authorization
  -> PORTAL admission decision
  -> OURTUNNELSELF session broker
  -> selected PIPE transport adapter
  -> registered device-side OURTUNNELSELF agent
  -> local OURSELFd Unix socket
  -> typed local capability
  -> independent observation and DATASELF receipt

The device agent initiates the network session outbound to the broker. The design does not require an inbound listener on the Mac and works behind ordinary NAT/firewalls when outbound TLS is permitted.

The broker is a rendezvous and message relay, not an authority root. It cannot mint device identity, enlarge caller jurisdiction, authorize a command, or claim execution from delivery acknowledgement.

## 3. Separation of concerns

- OSOS: canonical caller identity, device identity binding, jurisdiction, authority grants and revocation.
- OURHARDWARESELFS: device/substrate registry and identity evidence.
- PORTAL: evaluates exact source, target, direction, purpose, capability set, policy version, evidence freshness and lease expiry.
- OURTUNNELSELF: session lifecycle, provider-neutral tunnel identity, adapter selection, lease, sequence/replay controls, heartbeat and revocation propagation.
- PIPE: frames, correlates, routes, retries and delivers bounded messages.
- AGENTBRIDGE: maps an authorized seat's typed intent into an OURSELF request; it does not bypass OSOS or PORTAL.
- Device agent: maintains outbound connection and forwards only admitted typed requests to local OURSELFd.
- OURSELFd: local execution boundary; validates operation, target, capability and local policy.
- MODELSELFWITNESS / DATASELF: independently observe and preserve decision, actuation, result and receipt as separate facts.

## 4. Provider independence

A transport adapter is replaceable without changing tunnel identity, device identity, authority, or admission policy.

Initial adapter interface:
- connect(session_contract)
- send(envelope)
- receive()
- heartbeat()
- close(reason)
- health()

Potential adapters include direct TLS/WebSocket, self-hosted reverse WebSocket, WireGuard/private overlay, SSH reverse forwarding, and Cloudflare Tunnel as an optional adapter. No adapter is canonical. Provider-specific account identity must never become OURSELF identity.

## 5. Identity and enrollment

Each device receives a stable OURSELF device identity distinct from hostname, IP address, provider account, and OS username.

Enrollment is an explicit local ceremony:
1. Operator starts the device agent locally.
2. Agent creates or imports a device keypair using OS-supported secure storage where available.
3. Agent produces an enrollment request containing device identity, observed hostname/OS, public key, software version and evidence references.
4. OSOS/OURHARDWARESELFS evaluates identity binding and jurisdiction.
5. An authorized custodian approves enrollment through an independent control surface.
6. Broker issues only a short-lived session credential/certificate bound to the enrolled device key.
7. Device status remains DISCOVERED or IDENTITY_VERIFIED until all required evidence and admission transitions are independently satisfied.

A hostname, shared secret, successful TLS handshake, or online presence alone does not establish admission.

## 6. Session contract

Every session is bound to:
- tunnel_id and stable tunnel_identity
- device_identity_ref and endpoint_identity
- caller_identity_ref and seat_identity_ref
- source and target jurisdiction
- portal_decision_ref and authority_grant_ref
- admitted capability set
- purpose and request correlation ID
- issued_at, expires_at and revocation epoch
- transport adapter and transport session ID
- monotonic sequence number and nonce/replay window
- cryptographic key references and signature verification result

Session leases are short-lived and renewable only after rechecking revocation and admission. Device disconnect, expired lease, invalid signature, replay, policy mismatch or revocation closes the session and rejects pending operations.

## 7. Request and execution lifecycle

1. Seat submits a typed operation request.
2. Gateway authenticates the seat and resolves the canonical caller identity.
3. PORTAL evaluates the exact target, purpose, requested capabilities and current evidence.
4. OURTUNNELSELF establishes or reuses a non-expired admitted session.
5. Broker delivers a signed, bounded request envelope to the device agent.
6. Device agent validates audience, target device, session, signature, expiry, sequence, nonce, operation schema and capability.
7. Device agent forwards the request to local OURSELFd over its permission-restricted Unix socket.
8. OURSELFd independently validates local capability and target boundary.
9. The operation executes only if both remote admission and local enforcement pass.
10. Device returns a signed result envelope; broker records transport receipt separately.
11. Independent witness validates the result and records observed effect.
12. DATASELF stores request, portal decision, transport receipt, local execution receipt, witness record and integrity manifest with causal links.

Delivery acknowledgement is not execution acknowledgement. Execution receipt is not proof of external effect until independently observed.

## 8. Initial capability profile

Initial proof profile is READ-ONLY:
- repo.status / git_status against a registered repository root.
- repo.read only after a bounded path and byte-limit contract is implemented.
- repo.diff only after a bounded diff contract is implemented.
- device.health from an explicit local inventory allowlist.

Not exposed in v0.1:
- arbitrary shell or script execution
- arbitrary process start/stop
- unrestricted filesystem read/write
- credential/keychain export
- browser profile/session extraction
- privilege escalation
- silent service, network, boot, firmware or security-policy mutation

New capabilities require a schema, explicit jurisdiction and authority, local enforcement, negative tests, receipt contract and rollback where mutating.

## 9. Broker requirements

The broker is a minimal stateless or recoverable relay with:
- authenticated device registration and caller authentication
- device presence and session lease registry
- durable bounded request queue with TTL
- request/result correlation
- signature and replay validation
- revocation fan-out
- per-device and per-caller rate limits
- append-only audit events
- no arbitrary command interpretation
- no storage of private device keys
- no authority to widen admitted capabilities

The broker must be deployable on OURSELF-controlled infrastructure. Its public endpoint is an OURSELF domain under OURTUNNELSELF control. TLS termination, key custody, backups, logging and operator access must be documented.

## 10. ChatGPT and other seats

The ChatGPT-facing surface is an OURSELF-owned MCP server/plugin exposing only typed tools, for example:
- list_registered_devices
- inspect_device_health
- read_repo_status
- read_bounded_file
- request_scoped_operation
- inspect_execution_receipt
- revoke_device_session

The same MCP API may be consumed by another authorized seat. A seat is not trusted merely because it is ChatGPT, a browser, a model, or a logged-in user. Each seat must authenticate and map to an OSOS caller identity. Seat-specific OAuth or workload identity is separate from device identity.

No MCP tool may expose a generic exec(command) interface. Any future terminal-like experience must compile user intent into typed, policy-checked operations and preserve human approval for higher-risk classes.

## 11. Availability and cost model

The design removes the Desktop Commander product/account/usage quota as a dependency. It does not make internet reachability or hosting free.

For "from any seat" operation, an always-reachable OURSELF-controlled gateway is required. It can run on:
- an always-on OURSELF-owned server with a public address and managed ingress; or
- a modest hosted server controlled by OURSELF.

The Mac agent keeps an outbound connection to that gateway. Domain registration, compute, bandwidth, backups and any optional network provider may still incur cost. No third-party desktop-agent subscription is required.

If the gateway runs only on the Mac behind a home NAT, a self-hosted rendezvous/ingress path is still required for external seats. A local-only socket cannot be reached from ChatGPT.

## 12. Failure semantics

- No identity binding: deny.
- No jurisdiction or authority grant: deny.
- No valid PORTAL decision: deny.
- Expired or revoked lease: close and deny.
- Device key mismatch: quarantine.
- Invalid signature, nonce reuse or sequence rollback: reject and quarantine as policy dictates.
- Transport online but local OURSELFd unavailable: report transport connected, execution unavailable.
- Broker delivered but device did not execute: report delivered only.
- Device executed but witness absent: report executed/unwitnessed, not proven.
- Missing receipt: operation status is unverified.

## 13. Implementation phases

Phase A — Contract and branch isolation
- Freeze session, enrollment, request, result and receipt schemas.
- Add negative tests for identity, scope, expiry, replay and revocation.
- Preserve current OURSELFd read-only boundary.

Phase B — Local device agent
- Add outbound adapter interface and one self-hosted TLS/WebSocket adapter.
- Bind agent to local OURSELFd Unix socket.
- Install as a macOS launchd service with least privilege and explicit logs.
- Provide a manual enrollment/bootstrap command; no remote privilege escalation.

Phase C — OURSELF broker
- Deploy broker on OURSELF-controlled host/domain.
- Add authenticated device and seat registries, leases, bounded queue and revocation.
- Validate transport receipts independently of execution receipts.

Phase D — ChatGPT MCP surface
- Host an authenticated OURSELF MCP endpoint.
- Connect a private ChatGPT plugin/app to that endpoint.
- Expose only typed capabilities and receipt inspection.
- Verify that a second authorized seat can use the same gateway without sharing device credentials.

Phase E — witnessed proof
- Enroll OURSELFMAC.local.
- Execute read-only repo.status request from ChatGPT.
- Independently verify device identity, portal decision, transport receipt, local execution receipt and observed result.
- Only then expand the read-only capability profile.

## 14. Acceptance criteria

The system is not declared operational until all are true:
1. Desktop Commander is absent from the runtime dependency graph.
2. OURSELFMAC has a stable OURSELF device identity independent of provider.
3. Device initiates outbound connection to OURSELF-controlled gateway.
4. Two separately authenticated seats can request the same permitted read-only operation.
5. PORTAL decisions are scoped, signed, expiring and revocable.
6. Device agent rejects replay, expired, wrong-target and over-capability envelopes.
7. Local OURSELFd rejects operations outside its explicit capability registry.
8. Transport receipt, execution receipt and witnessed effect remain distinct.
9. Revocation closes active sessions and invalidates pending requests.
10. Reboot/reconnect restores device presence without changing canonical identity.
11. A full read-only proof run is reproducible from a clean client.
12. No paid Desktop Commander account or quota is required.

## 15. Current implementation truth

As of this specification:
- Existing PIPE and PORTAL contracts/policy exist.
- Existing OURSELFd is a local Unix-socket daemon with a narrow read-only repository capability.
- No production OURTUNNELSELF broker, outbound device agent, ChatGPT MCP gateway, enrollment signer, or remote session has been established by this document.
- This specification is not a deployment receipt and does not authorize mutation of the Mac.

Governing invariant:
DISCOVERY != IDENTITY != ADMISSION != CONNECTION != AUTHORIZATION != ACTUATION != OBSERVED EFFECT.
