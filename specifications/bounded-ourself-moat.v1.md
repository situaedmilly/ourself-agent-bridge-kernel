# boundedOURSELFMOAT v1.0.0

## Constitutional shift

`boundedOURSELFMOAT` treats the moat as a **possibility membrane**, not merely an admission filter.

The implementation maps the eight non-surface mutations to runtime invariants:

1. **ACCESS → POSSIBILITY**: capability admission constrains the state transitions that can exist.
2. **IDENTITY → CONTINUITY**: runtime identity is bound to PID, endpoint, and source SHA-256.
3. **ACTION_ID → ANTI-SUBSTITUTION**: action, capability, and intent are exact-bound.
4. **CAPABILITY → NEGATIVE SPACE**: default-deny semantics reject unknown capability space and retain shell/network/arbitrary path/payload/executable prohibitions.
5. **AUTHORIZATION → TEMPORAL OBJECT**: authorization is bounded by issued/expiry timestamps and the configured lifetime.
6. **CROSSING → EVIDENCE**: the receiver requires process observation and PID correlation for the caller.
7. **ADMISSION → GRAPH MUTATION**: successful execution must materialize a local graph admission after predecessor evidence is verified.
8. **RECEIPT → CUSTODY**: the receipt is persisted and re-contacted by digest before graph admission; no automatic destructive rollback is used.

## Boundary

This contract is implemented against the RAWMAC local OURSELFD runtime.

It does **not** establish institutional selfgraph admission. The runtime remains explicitly:

`LOCAL_ONLY_NOT_INSTITUTIONAL_SELFGRAPH`

## Execution evidence

The implementation was booted on RAWMAC, the launchd-resident OURSELFD restarted, AgentBridge restarted against the new endpoint, and a real `CREATE_LOCAL_WITNESS` transition was executed through:

`AgentBridge → process crossing observation → authorization → OURSELFD → actuator → observer → receipt → graph admission`

The exact execution witness is preserved in `logs/bounded-ourself-moat-boot-001.json`.
