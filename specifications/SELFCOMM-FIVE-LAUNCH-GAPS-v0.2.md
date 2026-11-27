# SELFCOMM five launch gaps — v0.2

This revision closes the five implementation gaps in reverse order (5 → 1) without activating T-034.

## Gap 5 — reality / worktree / pre-state binding

OURSELFd resolves the canonical Git root, commit, branch, dirty-state fingerprint, runtime source hashes, capability-contract hash, host, and boot ID. Instance creation stores a pre_state_hash. Every transition recomputes the pre-state and fails closed with PRE_STATE_DRIFT if it changed.

A dirty worktree is recorded, not automatically rejected. The operation target is restricted to the repository root.

## Gap 4 — durable instance / reality lineage

runtime/ourselfd/core.js writes INSTANCE_CREATED events to ~/.local/state/ourselfd/events.jsonl. Each event contains the full instance record, canonical record hash, sequence, previous event hash, and event hash. The ledger is replayed on process initialization; invalid sequence or hash continuity prevents startup.

Instance records bind principal, reality ID, pre-state hash, runtime host/PID/boot ID, and parent lineage.

## Gap 3 — durable receipt / restart / recontact

Successful transitions append RECEIPT_PERSISTED to the same fsynced hash-chained ledger before the receipt is returned. Recontact endpoints resolve the persisted instance and receipt after a daemon restart. Ledger corruption is fail-closed; no silent repair or state promotion occurs.

## Gap 2 — truthful capability registry / actuators

The active v0.2 contract exposes only repo.status → git_status, the one implemented actuator. repo.read and repo.diff are retained as NOT_IMPLEMENTED, not advertised as callable. Shell execution, process start, repository writes, file writes, and arbitrary filesystem access remain absent.

The historical ourselfd-capabilities.v0.1.json is preserved unchanged. Runtime source loads v0.2 explicitly.

## Gap 1 — AgentBridge identity → OURSELFd authorization

AgentBridge's existing requireToken middleware protects /ourselfd/*. The router forwards the same BRIDGE_TOKEN over the local Unix socket as x-ourself-agent-token. OURSELFd independently verifies the secret in constant time and maps it to the fixed agentbridge principal. Client-supplied principal labels are ignored. The authorization policy admits only agentbridge:repo.status.

The secret is loaded from the local ignored .env through dotenv/config; it is never written to source, logs, receipts, or API responses.

## Runtime and deployment

- Socket: %t/ourselfd/ourselfd.sock, mode 0600.
- Durable state: %h/.local/state/ourselfd/events.jsonl, mode 0600.
- User services: deploy/systemd/user/ourselfd.service and agentbridge.service.
- Both use the existing local Node 22.23.3 installation. Update the unit ExecStart paths only when the installed Node path changes.
- T-034 remains quarantined and is not imported, instantiated, or activated.

## Verification

Focused tests:
- reality and dirty-state precondition binding
- pre-state drift rejection
- principal mismatch and unimplemented capability denial
- full transition chain
- durable ledger replay after process reconstruction
- ledger tamper/corruption fail-closed
- authenticated AgentBridge router → OURSELFd socket → receipt → recontact

The full repository suite remains environment-sensitive. The Pi checkout has Mac-specific RUORA paths and shell assumptions; those failures are separate from this SELFCOMM slice and are not reclassified as passing.