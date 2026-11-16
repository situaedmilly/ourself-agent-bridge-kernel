# AgentBridge Operational Event Journal Binding v0.1

AgentBridge emits operational events and handoff evidence. Its event stream is not canonical memory and does not become DATASELF merely because it is durable.

## Binding rules

- Each event intended for canonical retention is serialized as exact bytes and wrapped in a DATASELF envelope.
- Event payloads use immutable content keys; event transitions append to the canonical hash-linked journal.
- The bridge retains its own local operational journal for runtime continuity, but labels it OPERATIONAL_EVENT until DATASELF admission completes.
- Agent, model, bridge, runtime, host, reality, and instance identities remain separate.
- Delivery acknowledgement is not storage persistence. Storage persistence is not authority. A receipt is not an independently witnessed effect.
- Replay uses transition IDs and nonces; duplicate delivery must be idempotent and must not duplicate canonical state.
- When the DATASELF adapter is unavailable, events remain in a bounded local queue with explicit pending custody state. No false canonical-persistence claim is emitted.

## Prohibited shortcuts

No model response, local JSONL file, transport acknowledgement, Git commit, or bridge API success may be represented as canonical memory admission without envelope resolution, exact-byte verification, journal lineage, and independent authority.
