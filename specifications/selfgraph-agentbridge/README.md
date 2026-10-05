# AGENTBRIDGE SELFGRAPH v0.1

This is the explicit AGENTBRIDGE realization graph for the OURSELF ecosystem.

## Canonical ownership

The graph registry lives in `ourself-agent-bridge-kernel`.

It is a **graph of evidence-bearing relationships**, not a replacement for the source repositories and not an authority mechanism.

The graph preserves distinct jurisdictions:

```text
COGNITION
  MODELSELF
      ↓
AGENTBRIDGE
      ↓
INTENT / PROPOSAL
      ↓
VALIDATION / POLICY
      ↓
OURSELFD
      ↓
ADMISSION / AUTHORITY
      ↓
ACTUATOR
      ↓
OBSERVATION
      ↓
EVIDENCE / RECEIPT
      ↓
PROVENANCE
      ↓
SELFGRAPH
      ↓
RECONTACT
```

## Concrete AgentBridge execution families

### Local terminal bridge

```text
server.js
  → token gate
  → pending proposal
  → HUMAN approval
  → live execution-class recheck
  → command firewall
  → executeCommand
  → proof relay
```

### BridgeSELF / RuntimeSELF

```text
PERSISTED PROPOSAL
  → integrity verification
  → BridgeSELF route
  → safe queue
  → RuntimeSELF orchestrator
  → witness / reconciliation / memory
```

The safe orchestrator does **not** consume the proposal, human-decision, or execution queues automatically.

### OURSELFMCP / OURPROCESSORSELF

```text
MCP MESSAGE
  → PROPOSAL
  → ProcessorControlPlane.admit()
  → PROCESSOR
  → CAUSAL ACTUATION
  → ACTUAL STATE READBACK
```

MCP transport is not authority, and notification is not effect.

## Cross-repository lineage

The graph binds exact file content through:

```text
repository + ref + commit SHA + blob SHA
```

The companion file `AGENTBRIDGE-SOURCE-MANIFEST.v0.1.tsv` contains those bindings.

Directly inspected AgentBridge-relevant jurisdictions are:

```text
ourself-agent-bridge
ourself-agent-bridge-kernel
ourself-core
self-protocol-suite
self-communication
OURPROCESSORSELF
SELFVEREIGN-ADDRESSELF
frekqenci-splash-portal
```

The complete visible `situaedmilly` repository inventory was also checked. A no-match indexed search on an unrelated repository is never treated as proof of absence.

## Constitutional boundary

```text
MODEL != AUTHORITY
MCP != AUTHORITY
CAPABILITY != AUTHORITY
AUTHORITY != ADMISSION
ADMISSION != ACTUATION
ACTUATION != EXECUTION
EXECUTION != EFFECT
RECEIPT != EFFECT
OBSERVATION != AUTHORITY
IDENTITY != ADDRESS
ADDRESS != LOCATION
TRANSPORT != PROOF
DECLARATION != RUNTIME_PRESENCE
NO_AUTHORITY -> NO_AUTHORIZED_EFFECT
```

The manifest therefore records:

```text
GRAPH PRESENCE      = MANIFESTED
SOURCE PRESENCE     = PINNED
RUNTIME REALIZATION = NOT_ESTABLISHED
```

The graph cannot promote itself to runtime reality, grant authority, or manufacture a receipt.
