# Mission Kernel v0 — Specification

```
class: SPECIFICATION
status: INITIAL_DRAFT
authority: PENDING_FOUNDER_REVIEW
implementation_status: NOT_IMPLEMENTED
```

This document is a governance-layer design contract. It is not doctrine, not
sealed, and not itself an implementation. Implementation authorization does
not ratify this specification; ratification is a separate Founder act.

## 1. Purpose

Mission is the durable primitive beneath OURSELFROOT — not the agent session.
Agents (executors) are temporary. Sessions are disposable. Missions persist
across executor swaps, interruptions, and rate limits.

## 2. Mission Kernel record (conceptual schema)

A Mission Kernel record has, at minimum:

- `mission_id` — durable identifier, assigned at creation, never reassigned.
- `state` — one of the lifecycle states in §3. Legal transitions only.
- `intent` — purpose, objectives, scope boundary, prohibited actions. Written
  once at creation; immutable thereafter (a new intent requires a new
  mission, not a mutation of this field).
- `current_executor` — executor_id, executor_type, assigned_at, and the
  explicit permissions granted to this specific assignment.
- `executor_history` — append-only list of prior executor assignments and
  their release records (§4).
- `interruption_state` — see §5.
- `evidence` — proof entries relevant to this mission's objectives. Evidence
  may satisfy a prerequisite for promotion; it never itself authorizes
  promotion (§6).
- `promotion_boundary` — status only, see §6.
- `history` — append-only event log of everything recorded against this
  mission (transitions, executor changes, interruptions, handoffs).

## 3. Lifecycle state machine

States:

```
INITIALIZED, ORIENTED, EXECUTING, PAUSED, INTERRUPTED, COMPLETED, FAILED, SEALED
```

Legal transitions:

```
INITIALIZED → ORIENTED | FAILED
ORIENTED     → EXECUTING | PAUSED | FAILED
EXECUTING    → PAUSED | INTERRUPTED | COMPLETED | FAILED
PAUSED       → ORIENTED | EXECUTING | INTERRUPTED | FAILED
INTERRUPTED  → ORIENTED | PAUSED | FAILED
COMPLETED    → SEALED
FAILED       → (none — terminal)
SEALED       → (none — terminal)
```

Any transition not listed above is illegal and MUST be rejected fail-closed.
Reaching `SEALED` is a state fact only; it does not itself grant promotion
authority (state transition and Promotion Boundary status are separate
concepts — see §6).

## 4. Executor replacement law

1. A released executor emits a release record: completed tasks, evidence
   produced, and any drift observed. It does not mutate mission intent.
2. A newly assigned executor MUST NOT assume prior authorization. It must
   re-read the immutable `intent`, compare current observed state against
   the mission's last recorded preconditions, and classify any divergence
   as one of: `EXPECTED`, `RECOVERABLE`, or `FAILURE_STATE`.
3. `FAILURE_STATE` drift requires escalation (human gate) before any further
   execution; it is never auto-resolved.
4. Each executor assignment carries its own explicit permission grant; no
   permission is inherited from a prior executor.

## 5. Interruption and recovery law

- An interruption is recorded with a detection timestamp and a tolerance
  window (mission- or permission-scoped).
- Within tolerance: the same executor may resume without a new assignment.
- Beyond tolerance: the mission transitions to `PAUSED` and requires a new
  executor assignment, which re-enters the mission at `ORIENTED` (§4).
- Interruption records are append-only; they are never overwritten or
  silently repaired.

## 6. Promotion Boundary contract

The Mission Kernel — and any store implementing it — may **report** evidence
readiness. It may never **authorize, infer, decide, or perform** promotion.

```
promotion_boundary:
  status: NOT_CROSSED
  validator_authority: NONE
  evidence_state: <reported state only>
  reason: Explicit human authorization is required for promotion.
```

No method in an implementing module may return a value asserting that
promotion has occurred or is permitted. Verified evidence satisfies a
prerequisite; it does not unlock the boundary.

## 7. Platform equivalence (forward reference, not in v0 implementation scope)

Same intent, same constraints, same authority, different platform adapter →
equivalent governed result: same authority boundary preserved, same
prohibited actions remain prohibited, same required confirmations occur,
equivalent evidence produced. Apple / Android / Windows / cloud adapters are
explicitly out of scope for the v0 persistence implementation.

## 8. TaskPacket / HandoffPacket / ExecutionReceipt relationship

- A **TaskPacket** is a bounded, authorized unit of work issued against a
  Mission Kernel; it references `mission_id` and carries its own scope,
  forbidden files, and stop conditions. It does not live inside the kernel
  record — the kernel records that it was issued and its outcome.
- A **HandoffPacket** is emitted by the kernel store at executor transition:
  a snapshot of sealed intent, observed state, completed/pending work, and a
  readiness checklist for the next executor (§4).
- An **ExecutionReceipt** is emitted by an executor on release, and is
  appended to `executor_history` (§4) — it is evidence, not authority.

## 9. Responsibility boundary for a v0 persistence implementation

MAY enforce:
- schema validity
- append-only event integrity
- deterministic reconstruction from a durable log
- legal lifecycle transitions only (§3)
- immutable authority fields (never rewritten post-create)
- explicit executor replacement records (§4)
- interruption records (§5)
- Promotion Boundary non-crossing, reporting only (§6)

MAY NOT:
- grant authority
- verify semantic truth
- approve evidence
- execute platform actions
- route models
- infer human consent
- promote any record
- mutate sealed doctrine

## 10. Unresolved design questions (not resolved by this draft)

- Exact shape of `evidence` entries and how `evidence_state` is summarized
  for `getPromotionBoundaryStatus`.
- Whether `executor_history` and `history` are the same append-only log or
  two distinct ledgers.
- Multi-mission relationships (parent/child missions) are not addressed.
- Cross-repository mission references (e.g. control plane ↔ kernel) are not
  addressed.
- Concurrent executor assignment (more than one active executor) is not
  addressed; v0 assumes exactly one `current_executor` at a time.

## 11. Specification binding

Any implementation claiming conformance to this document must record the
exact SHA-256 digest of this file at implementation time. If implementation
requires a change to this specification, the implementing agent MUST STOP
and record:

```
status: STOPPED
reason: SPECIFICATION_DEVIATION
authority_required: FOUNDER_REVIEW
```

The implementing agent must never silently revise this specification to
match its code.
