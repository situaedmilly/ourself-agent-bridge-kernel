// tools/proof-path-driver.js
// ── SL-003: Synchronous Proof-Path Driver ───────────────────────────────────
//
// PURPOSE
//   The single synchronous entry point that composes the already-sealed
//   T-027..T-033 modules into one governed proof path:
//
//     INTAKE (T-027 adapter, optional)
//       → PERSIST (T-030 pending proposal + hash-chained ledger)
//       → HUMAN_TURN (T-031 decision, verifier-injected)
//       → EXECUTE (T-032 bounded derived operation)
//       → WITNESS (T-033 independent bounded observation)
//       → RECONCILE (T-033 semantic reconciliation)
//
//   This driver ADDS NO SEMANTICS. Every validation, boundary, hash, and
//   refusal belongs to the sealed modules it calls. The driver only
//   sequences them fail-closed and reports each stage's own result.
//
// CONTAINMENT LAW (immutable, SL-003)
//   This module SHALL NOT import:
//     • persistence/queue-store.js
//     • runtime/orchestrator.js  (or any runtime/* module)
//   The T-034 queue/runtime subsystem remains QUARANTINED
//   (specifications/T-034-RUNTIME-QUARANTINE-DISPOSITION.md). Activation
//   requires a separate authorization gate. A regression test enforces
//   this law against this file's source text.
//
// FAIL-CLOSED SEQUENCING
//   • A stage that returns ok:false halts the run; no later stage executes.
//   • A REJECT decision is a LAWFUL halt (ok:true, completed:false), not an
//     error: governance worked.
//   • A DIVERGED or INDETERMINATE reconciliation is reported, never
//     remediated here — remediation lives outside the verification layer.

'use strict';

import { isAbsolute, resolve } from 'node:path';
import {
  persistPendingProposal,
  verifyPendingProposal,
  verifyEventLedger,
} from '../persistence/pending-proposals.js';
import {
  createHumanTurnDecisionService,
  DECISION_VERSION,
} from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import { verifyExecutionWitness } from '../persistence/execution-witness.js';
import {
  createExecutionWitnessService,
  recordSemanticReconciliation,
  verifySemanticReconciliation,
} from '../persistence/semantic-reconciliation.js';
import { processOurselfIntake } from '../adapters/ourself-intake.js';

export const DRIVER_VERSION = 'ourself.proof-path-driver.v1';

export const DRIVER_STAGES = Object.freeze([
  'INTAKE',
  'PERSIST',
  'HUMAN_TURN',
  'EXECUTE',
  'WITNESS',
  'RECONCILE',
]);

export const DRIVER_ERRORS = Object.freeze({
  INVALID_CONFIG: 'INVALID_CONFIG',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INTAKE_REJECTED: 'INTAKE_REJECTED',
  STAGE_FAILED: 'STAGE_FAILED',
});

function assertAbsolutePath(value, name) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError(`createProofPathDriver requires an absolute ${name}`);
  }
  return resolve(value);
}

/**
 * Create the synchronous proof-path driver.
 *
 * @param {object} config
 * @param {string} config.storageRoot - absolute durable proof store (SL-004 root).
 * @param {string} config.authorizedExecutionRoot - absolute workspace T-032 may execute in.
 * @param {string} [config.authorizedObservationRoot] - absolute workspace T-033 observes
 *   (defaults to authorizedExecutionRoot).
 * @param {function} config.verifyHumanTurnAuthorization - injected T-031 verifier seam.
 * @param {function} [config.now] - ISO-8601 clock injection (defaults inside sealed modules).
 * @param {function} [config.executionSpawnImpl] - T-032 spawn injection (tests only).
 * @param {function} [config.observationSpawnImpl] - T-033 spawn injection (tests only).
 * @param {number} [config.timeoutMs] - passed through to T-032/T-033.
 * @param {number} [config.maxOutputBytes] - passed through to T-032/T-033.
 * @returns {{ runProofPath: function, verifyProofChain: function }}
 */
export function createProofPathDriver(config) {
  const cfg = config || {};
  const storageRoot = assertAbsolutePath(cfg.storageRoot, 'storageRoot');
  const executionRoot = assertAbsolutePath(cfg.authorizedExecutionRoot, 'authorizedExecutionRoot');
  const observationRoot = cfg.authorizedObservationRoot === undefined
    ? executionRoot
    : assertAbsolutePath(cfg.authorizedObservationRoot, 'authorizedObservationRoot');
  if (typeof cfg.verifyHumanTurnAuthorization !== 'function') {
    throw new TypeError('createProofPathDriver requires a verifyHumanTurnAuthorization function');
  }
  const passthrough = {};
  if (typeof cfg.now === 'function') passthrough.now = cfg.now;
  if (Number.isInteger(cfg.timeoutMs)) passthrough.timeoutMs = cfg.timeoutMs;
  if (Number.isInteger(cfg.maxOutputBytes)) passthrough.maxOutputBytes = cfg.maxOutputBytes;

  const decisionService = createHumanTurnDecisionService({
    verifyHumanTurnAuthorization: cfg.verifyHumanTurnAuthorization,
  });

  function failResult(stages, haltedAt, error, message) {
    return {
      ok: false,
      completed: false,
      driver_version: DRIVER_VERSION,
      proposal_id: stages.persist?.proposal_id ?? null,
      halted_at: haltedAt,
      error,
      message: message || null,
      stages,
    };
  }

  /**
   * Run one proposal through the full synchronous proof path.
   *
   * @param {object} request
   * @param {object} [request.envelope] - OURSELF control-plane envelope; runs
   *   T-027 intake. Exactly one of envelope / reviewResult is required.
   * @param {object} [request.reviewResult] - already-adapted kernel review
   *   result (the T-027 adapter's ACCEPTED_FOR_REVIEW output).
   * @param {object} request.decision - the Human_TURN input:
   *   { decision: 'AUTHORIZE'|'REJECT', decisionId, decidedBy, decidedAt,
   *     reason, presentedToken, constraints? }.
   *   All fields are recorded verbatim by the sealed T-031 service; this
   *   driver invents none of them.
   */
  async function runProofPath(request) {
    const req = request || {};
    const stages = {};

    const hasEnvelope = req.envelope !== undefined;
    const hasReviewResult = req.reviewResult !== undefined;
    if (hasEnvelope === hasReviewResult) {
      return failResult(stages, 'INTAKE', DRIVER_ERRORS.INVALID_REQUEST,
        'exactly one of envelope or reviewResult is required');
    }
    const d = req.decision;
    if (!d || typeof d !== 'object'
      || (d.decision !== 'AUTHORIZE' && d.decision !== 'REJECT')
      || typeof d.decisionId !== 'string' || d.decisionId.length === 0
      || typeof d.decidedBy !== 'string' || d.decidedBy.length === 0
      || typeof d.decidedAt !== 'string' || d.decidedAt.length === 0
      || typeof d.reason !== 'string' || d.reason.length === 0) {
      return failResult(stages, 'INTAKE', DRIVER_ERRORS.INVALID_REQUEST,
        'decision requires decision (AUTHORIZE|REJECT), decisionId, decidedBy, decidedAt, reason');
    }

    // ── INTAKE (T-027) ──────────────────────────────────────────────────────
    let reviewResult;
    if (hasEnvelope) {
      const intake = processOurselfIntake(req.envelope);
      stages.intake = intake;
      if (intake.status !== 'ACCEPTED_FOR_REVIEW') {
        return failResult(stages, 'INTAKE', DRIVER_ERRORS.INTAKE_REJECTED,
          intake.error?.message || `intake returned ${intake.status}`);
      }
      // T-030 requires reviewResult.protocol; the adapter's output omits it.
      // Carry the envelope's own protocol forward — the adapter already
      // validated it equals 'ourself.ae-kernel.v1' before accepting.
      reviewResult = { protocol: req.envelope.protocol, ...intake };
    } else {
      stages.intake = { skipped: true, reason: 'caller supplied an adapted reviewResult' };
      reviewResult = req.reviewResult;
    }

    // ── PERSIST (T-030) ─────────────────────────────────────────────────────
    const persisted = await persistPendingProposal(storageRoot, reviewResult);
    stages.persist = persisted;
    if (!persisted.ok) {
      return failResult(stages, 'PERSIST', DRIVER_ERRORS.STAGE_FAILED, persisted.message || persisted.error);
    }
    const proposalId = persisted.proposal_id;
    const record = persisted.record;
    const latestEvent = record.events[record.events.length - 1];

    // ── HUMAN_TURN (T-031) ──────────────────────────────────────────────────
    const decisionInput = {
      decision_version: DECISION_VERSION,
      decision_id: d.decisionId,
      proposal_id: proposalId,
      decision: d.decision,
      decided_by: d.decidedBy,
      decided_at: d.decidedAt,
      proposal_integrity: {
        record_hash: record.integrity.record_hash,
        semantic_checksum: record.semantic_checksum,
        latest_event_hash: latestEvent.event_hash,
      },
      reason: d.reason,
      constraints: Array.isArray(d.constraints) ? d.constraints : [],
    };
    const decided = await decisionService.recordHumanTurnDecision({
      storageRoot,
      proposalId,
      decisionInput,
      presentedToken: d.presentedToken,
    });
    stages.human_turn = decided;
    if (!decided.ok) {
      return failResult(stages, 'HUMAN_TURN', DRIVER_ERRORS.STAGE_FAILED, decided.message || decided.error);
    }
    if (d.decision === 'REJECT') {
      // Lawful governance halt — the pipeline worked and the human said no.
      return {
        ok: true,
        completed: false,
        driver_version: DRIVER_VERSION,
        proposal_id: proposalId,
        halted_at: 'HUMAN_TURN',
        outcome: 'REJECTED_BY_HUMAN_TURN',
        stages,
      };
    }

    // ── EXECUTE (T-032) ─────────────────────────────────────────────────────
    const executor = createBoundedProposalExecutor({
      authorizedExecutionRoot: executionRoot,
      ...(typeof cfg.executionSpawnImpl === 'function' ? { spawnImpl: cfg.executionSpawnImpl } : {}),
      ...passthrough,
    });
    const executed = await executor.executeAuthorizedProposal({ storageRoot, proposalId });
    stages.execute = executed;
    if (!executed.ok) {
      return failResult(stages, 'EXECUTE', DRIVER_ERRORS.STAGE_FAILED, executed.message || executed.error);
    }

    // ── WITNESS (T-033 part 1) ──────────────────────────────────────────────
    const witnessService = createExecutionWitnessService({
      authorizedObservationRoot: observationRoot,
      ...(typeof cfg.observationSpawnImpl === 'function' ? { spawnImpl: cfg.observationSpawnImpl } : {}),
      ...passthrough,
    });
    const witnessed = await witnessService.captureExecutionWitness({ storageRoot, proposalId });
    stages.witness = witnessed;
    if (!witnessed.ok) {
      return failResult(stages, 'WITNESS', DRIVER_ERRORS.STAGE_FAILED, witnessed.message || witnessed.error);
    }

    // ── RECONCILE (T-033 part 2) ────────────────────────────────────────────
    const reconciled = await recordSemanticReconciliation({ storageRoot, proposalId });
    stages.reconcile = reconciled;
    if (!reconciled.ok) {
      return failResult(stages, 'RECONCILE', DRIVER_ERRORS.STAGE_FAILED, reconciled.message || reconciled.error);
    }

    return {
      ok: true,
      completed: true,
      driver_version: DRIVER_VERSION,
      proposal_id: proposalId,
      halted_at: null,
      outcome: {
        reconciliation_status: reconciled.status,
        outcome_class: reconciled.outcome_class ?? null,
      },
      stages,
    };
  }

  /**
   * Cold re-verification of one COMPLETED proposal's persisted proof chain
   * plus the storage root's hash-chained event ledger. Read-only; composes
   * the sealed modules' own end-state verifiers, adds no verification logic.
   *
   * verifyProposalDecision is deliberately NOT part of this set: by sealed
   * design it is stage-scoped (it requires the decision event to be the
   * LATEST event, which is only true before execution advances the record).
   * For a chain halted at HUMAN_TURN, call it directly from
   * persistence/human-turn-decisions.js. Decision-event integrity within a
   * completed chain is enforced by the hash-chained event ledger.
   */
  async function verifyProofChain({ proposalId }) {
    return verifyPersistedProofChain({ storageRoot, proposalId });
  }

  return { runProofPath, verifyProofChain };
}

// Read-only entry point for fresh-process recontact. Verification needs no
// execution root or authority verifier and cannot dispatch an operation.
export async function verifyPersistedProofChain({ storageRoot, proposalId }) {
  const root = assertAbsolutePath(storageRoot, 'storageRoot');
  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    return { ok: false, error: DRIVER_ERRORS.INVALID_REQUEST, message: 'proposalId is required' };
  }
  const checks = {
    pending_proposal: await verifyPendingProposal(root, proposalId),
    execution_witness: await verifyExecutionWitness(root, proposalId),
    semantic_reconciliation: await verifySemanticReconciliation(root, proposalId),
    event_ledger: await verifyEventLedger(root),
  };
  const integrityValid = Object.values(checks).every(c => c && c.ok === true && c.valid === true);
  const complete = checks.execution_witness.witnessed === true
    && checks.semantic_reconciliation.reconciled === true;
  return { ok: integrityValid && complete, driver_version: DRIVER_VERSION,
    proposal_id: proposalId, checks,
    ...(!complete ? { error: 'PROOF_CHAIN_INCOMPLETE' } : {}),
  };
}
