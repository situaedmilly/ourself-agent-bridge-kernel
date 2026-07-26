// persistence/semantic-reconciliation.js
// ── T-033 (part 2): Durable Witness Capture and Semantic Reconciliation ─────
//
// PURPOSE
//   Convert a terminal T-032 execution (EXECUTION_COMPLETED / EXECUTION_FAILED)
//   into (a) exactly one durable, independently observed witness packet and
//   (b) exactly one durable, deterministic reconciliation verdict — WITHOUT
//   re-executing the proposal, creating authority, mutating the target, or
//   invoking any model judgment. The pure primitives live in
//   persistence/execution-witness.js; this module owns the persistence,
//   one-shot claims, idempotency, and crash-resume behavior.
//
// STATE LAW (deliberate, recorded design decision)
//   T-033 NEVER rewrites record.state and NEVER modifies a sealed module.
//   The witness lives in record.witness; the verdict lives in
//   record.reconciliation; both are bound into the record hash and mirrored
//   as hash-chained ledger events (WITNESS_CAPTURED, then exactly one of
//   RECONCILED / RECONCILIATION_DIVERGED / RECONCILIATION_INDETERMINATE).
//   The T-032 execution state machine remains untouched, so every sealed
//   T-030/T-031/T-032 behavior is preserved bit-for-bit on every record it
//   ever sees. Post-witness integrity is proven by verifyPendingProposal
//   (whole-record hash), verifyEventLedger, verifyExecutionWitness, and
//   verifySemanticReconciliation — never by loosening a sealed verifier.
//
// TRUST BOUNDARY (mirrors T-031/T-032)
//   All observation-shaping configuration — the authorized observation root,
//   timeout, output limits, the clock, and the spawn implementation — enters
//   ONLY at trusted construction time (createExecutionWitnessService). The
//   untrusted per-call request carries ONLY { storageRoot, proposalId }; any
//   profile-, command-, path-, environment-, normalization-, credential- or
//   plan-shaped field is rejected outright (WITNESS_OVERRIDE_FORBIDDEN).
//
// ONE-SHOT LAW
//   At most one observation per proposal, ever — proposal-scoped O_EXCL claim
//   file under <storageRoot>/witnesses/, never deleted by this module. At most
//   one reconciliation per proposal — same claim pattern under
//   <storageRoot>/reconciliations/. Completed repeats return the recorded
//   result without re-observing or recomputing-and-rewriting. There is NO
//   automatic retry, NO automatic rollback, and NO stale-claim deletion.
//
// CRASH-RESUME LAW
//   A fresh process resumes from persisted state only: a persisted witness is
//   sufficient to reconcile (no re-observation), and an interrupted capture
//   (claim without witness) surfaces CONCURRENT_WITNESS_CONFLICT for explicit
//   human-governed recovery — exactly the T-032 posture.
//
// HARD INVARIANTS (this module NEVER)
//   • executes or re-executes a proposal;
//   • mutates the observed target;
//   • accepts a HUMAN-TURN credential in any field;
//   • invokes an LLM or fuzzy comparison;
//   • rewrites record.state, authority, packet, plan, or execution result;
//   • rolls back or retries anything automatically;
//   • deletes or repairs a claim, record, or ledger line.

'use strict';

import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import {
  getPendingProposal,
  verifyPendingProposal,
  verifyEventLedger,
  resolveProposalPath,
  assertNotSymlink,
  atomicWriteJson,
  appendGlobalEvent,
  computeRecordHash,
} from './pending-proposals.js';
import { canonicalHash } from './canonical-json.js';
import {
  EXECUTION_WITNESS_ERRORS,
  WITNESS_EVENT_VERSION,
  RECONCILIATION_STATUSES,
  selectWitnessProfile,
  captureTargetFingerprint,
  runBoundedObservation,
  buildWitnessPacket,
  computeWitnessHash,
  verifyExecutionWitness,
  computeProfileReconciliation,
} from './execution-witness.js';

export const RECONCILIATION_VERSION = 'ourself.semantic-reconciliation.v1';
export const RECONCILIATION_EVENT_VERSION = 'ourself.semantic-reconciliation-event.v1';

// The exact defensible claim persisted with every verdict — the verdict never
// asserts more than this.
export const BOUNDED_RECONCILIATION_CLAIM =
  'A T-033 reconciliation result proves only whether a fresh, bounded, ' +
  'deterministic observation agrees with the execution result and witness ' +
  'profile bound to the authorized execution plan. It does not independently ' +
  'prove every human, institutional, metaphysical, economic, or real-world ' +
  'consequence implied by the original free-form intent.';

export const SEMANTIC_RECONCILIATION_ERRORS = Object.freeze({
  INVALID_RECONCILIATION_REQUEST: 'INVALID_RECONCILIATION_REQUEST',
  WITNESS_NOT_CAPTURED: 'WITNESS_NOT_CAPTURED',
  RECONCILIATION_ALREADY_RECORDED: 'RECONCILIATION_ALREADY_RECORDED',
  RECONCILIATION_IDENTITY_CONFLICT: 'RECONCILIATION_IDENTITY_CONFLICT',
  CONCURRENT_RECONCILIATION_CONFLICT: 'CONCURRENT_RECONCILIATION_CONFLICT',
  RECONCILIATION_WRITE_FAILED: 'RECONCILIATION_WRITE_FAILED',
  RECONCILIATION_INTEGRITY_FAILURE: 'RECONCILIATION_INTEGRITY_FAILURE',
});

const WERR = EXECUTION_WITNESS_ERRORS;
const RERR = SEMANTIC_RECONCILIATION_ERRORS;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES_CAP = 256 * 1024;

const TERMINAL_EXECUTION_STATES = Object.freeze(['EXECUTION_COMPLETED', 'EXECUTION_FAILED']);

// Any of these on the UNTRUSTED per-call request is an attempted override of
// the frozen witness law (or a smuggled credential) and fails the whole call.
// None is ever read for any purpose other than this rejection.
const FORBIDDEN_REQUEST_FIELDS = Object.freeze([
  'profile', 'profileId', 'profile_id', 'witnessProfile', 'witness_profile',
  'command', 'action', 'argv', 'args', 'executable', 'operation', 'plan',
  'cwd', 'workingDir', 'working_directory', 'env', 'environment',
  'timeout', 'timeoutMs', 'timeout_ms', 'maxOutputBytes', 'shell',
  'normalization', 'normalizationVersion', 'normalization_version',
  'spawn', 'spawnImpl', 'observation', 'witness', 'reconciliation',
  'token', 'presentedToken', 'authorization_token', 'expectedToken',
  'expected_authorization_token', 'expected_token',
]);

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function witnessesDir(storageRoot) {
  return join(storageRoot, 'witnesses');
}

function witnessClaimPath(storageRoot, proposalId) {
  return join(witnessesDir(storageRoot), `${proposalId}.lock`);
}

function reconciliationsDir(storageRoot) {
  return join(storageRoot, 'reconciliations');
}

function reconciliationClaimPath(storageRoot, proposalId) {
  return join(reconciliationsDir(storageRoot), `${proposalId}.lock`);
}

/** Recompute a reconciliation block's hash exactly as it was created. */
export function computeReconciliationHash(reconciliation) {
  const { reconciliation_hash, ...rest } = reconciliation;
  return canonicalHash(rest);
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') {
    return fail(WERR.INVALID_WITNESS_REQUEST, 'request must be an object');
  }
  for (const field of FORBIDDEN_REQUEST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(request, field)) {
      return fail(WERR.WITNESS_OVERRIDE_FORBIDDEN, `request may not carry "${field}" — witness law derives only from persisted state and trusted construction`);
    }
  }
  const { storageRoot, proposalId } = request;
  if (typeof storageRoot !== 'string' || storageRoot.length === 0 || typeof proposalId !== 'string' || proposalId.length === 0) {
    return fail(WERR.INVALID_WITNESS_REQUEST, 'storageRoot and proposalId are required');
  }
  return { ok: true, storageRoot, proposalId };
}

/**
 * Shared precondition: the proposal must exist, be integrity-clean, and hold
 * a terminal execution result. Returns the record on success.
 */
async function loadTerminalExecution(storageRoot, proposalId) {
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;
  if (!TERMINAL_EXECUTION_STATES.includes(record.state) || !record.execution || !record.execution.result) {
    return fail(WERR.WITNESS_EXECUTION_NOT_TERMINAL, `proposal state is ${record.state} — only a terminal execution can be witnessed`);
  }
  const recordIntegrity = await verifyPendingProposal(storageRoot, proposalId);
  if (!recordIntegrity.ok) return recordIntegrity;
  if (recordIntegrity.valid === false) {
    return fail(WERR.WITNESS_INTEGRITY_FAILURE, JSON.stringify(recordIntegrity.details));
  }
  const ledgerIntegrity = await verifyEventLedger(storageRoot);
  if (ledgerIntegrity.valid === false) {
    return fail(WERR.WITNESS_INTEGRITY_FAILURE, JSON.stringify(ledgerIntegrity));
  }
  return { ok: true, record };
}

/**
 * Construct the T-033 witness service. ALL observation-shaping configuration
 * enters here, through trusted composition code (or an isolated test) —
 * never through the per-call request.
 *
 * @param {object} config
 * @param {string} config.authorizedObservationRoot - absolute directory that bounds the observed cwd.
 * @param {number} [config.timeoutMs] - bounded; clamped to [1, MAX_TIMEOUT_MS].
 * @param {number} [config.maxOutputBytes] - per stream; clamped to MAX_OUTPUT_BYTES_CAP.
 * @param {function(): string} [config.now] - injectable ISO-timestamp clock.
 * @param {function} [config.spawnImpl] - injectable spawn (tests only).
 * @returns {{ captureExecutionWitness: function }}
 */
export function createExecutionWitnessService(config) {
  const cfg = config || {};
  if (typeof cfg.authorizedObservationRoot !== 'string' || cfg.authorizedObservationRoot.length === 0 || !isAbsolute(cfg.authorizedObservationRoot)) {
    throw new TypeError('createExecutionWitnessService requires an absolute authorizedObservationRoot');
  }
  const authorizedRoot = resolve(cfg.authorizedObservationRoot);
  const timeoutMs = Math.min(Math.max(Number.isInteger(cfg.timeoutMs) ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS, 1), MAX_TIMEOUT_MS);
  const maxOutputBytes = Math.min(Math.max(Number.isInteger(cfg.maxOutputBytes) ? cfg.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES, 1), MAX_OUTPUT_BYTES_CAP);
  const now = typeof cfg.now === 'function' ? cfg.now : () => new Date().toISOString();
  const spawnImpl = typeof cfg.spawnImpl === 'function' ? cfg.spawnImpl : undefined;

  /**
   * Capture exactly one fresh, bounded, independent observation for a
   * terminal execution and persist it as record.witness plus a
   * WITNESS_CAPTURED ledger event.
   * @param {object} request - UNTRUSTED. Only { storageRoot, proposalId } are read.
   */
  async function captureExecutionWitness(request) {
    const req = validateRequest(request);
    if (!req.ok) return req;
    const { storageRoot, proposalId } = req;

    const loaded = await loadTerminalExecution(storageRoot, proposalId);
    if (!loaded.ok) return loaded;
    const record = loaded.record;

    // One-shot idempotency: a persisted witness is returned, never re-observed.
    if (record.witness) {
      const witnessCheck = await verifyExecutionWitness(storageRoot, proposalId);
      if (witnessCheck.ok && witnessCheck.valid === true && witnessCheck.witnessed === true) {
        return {
          ok: true,
          idempotent: true,
          code: WERR.WITNESS_ALREADY_CAPTURED,
          proposal_id: proposalId,
          witness: record.witness,
          record,
        };
      }
      return fail(WERR.WITNESS_INTEGRITY_FAILURE, 'a witness exists but fails integrity verification — refusing to overwrite or re-observe');
    }

    const plan = record.execution.plan;

    // Frozen-profile selection from the PERSISTED plan only.
    const selected = selectWitnessProfile(plan);
    if (!selected.ok) return selected;
    const profile = selected.profile;

    // Fresh target fingerprint — the target must still be the planned one.
    const fp = await captureTargetFingerprint({ planCwd: plan.cwd, authorizedRoot });
    if (!fp.ok) return fp;

    // ── One-shot exclusive claim (O_EXCL) — never deleted by this module ────
    const idCheck = resolveProposalPath(storageRoot, proposalId);
    if (!idCheck.ok) {
      return fail(WERR.INVALID_WITNESS_REQUEST, 'proposal id is not a safe storage token');
    }
    const claimPath = witnessClaimPath(storageRoot, proposalId);
    if (!(await assertNotSymlink(claimPath))) {
      return fail(WERR.CONCURRENT_WITNESS_CONFLICT, 'witness claim path is a symlink — refusing');
    }
    try {
      await mkdir(witnessesDir(storageRoot), { recursive: true });
      await writeFile(claimPath, JSON.stringify({ witness_id: `wit-${proposalId}`, proposal_id: proposalId, claimed_at: now(), pid: process.pid }) + '\n', { flag: 'wx' });
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        return fail(WERR.CONCURRENT_WITNESS_CONFLICT, 'another caller already holds the witness claim for this proposal; interrupted-capture recovery requires a separate explicit law — no automatic retry');
      }
      return fail(WERR.WITNESS_WRITE_FAILED, String(err && err.message || err));
    }

    // Post-claim re-read: the state we validated must still hold.
    const reread = await getPendingProposal(storageRoot, proposalId);
    if (!reread.ok || reread.record.integrity.record_hash !== record.integrity.record_hash || reread.record.witness) {
      return fail(WERR.CONCURRENT_WITNESS_CONFLICT, 'proposal changed between validation and claim');
    }

    // ── The single fresh, bounded, read-only observation ─────────────────────
    const observation = await runBoundedObservation({
      spawnImpl,
      executable: profile.observation.executable,
      argv: profile.observation.argv,
      cwd: plan.cwd,
      timeoutMs,
      maxOutputBytes,
      now,
    });

    const packet = buildWitnessPacket({ proposalId, record, profile, observation, fingerprint: fp.fingerprint });
    const capturedAt = packet.observation_completed_at;

    let globalEvent;
    try {
      globalEvent = await appendGlobalEvent(storageRoot, {
        event_version: WITNESS_EVENT_VERSION,
        type: 'WITNESS_CAPTURED',
        proposal_id: proposalId,
        execution_id: record.execution.execution_id,
        plan_hash: plan.plan_hash,
        execution_result_hash: record.execution.result_hash,
        semantic_checksum: record.semantic_checksum,
        witness_profile_id: profile.profile_id,
        witness_hash: packet.witness_hash,
        observation_classification: packet.observation_classification,
        at: capturedAt,
      });
    } catch (err) {
      return fail(WERR.WITNESS_WRITE_FAILED, String(err && err.message || err));
    }

    const witnessedRecord = {
      ...record,
      witness: packet,
      events: [
        ...record.events,
        {
          event_version: WITNESS_EVENT_VERSION,
          type: 'WITNESS_CAPTURED',
          proposal_id: proposalId,
          execution_id: record.execution.execution_id,
          plan_hash: plan.plan_hash,
          execution_result_hash: record.execution.result_hash,
          semantic_checksum: record.semantic_checksum,
          witness_profile_id: profile.profile_id,
          witness_hash: packet.witness_hash,
          observation_classification: packet.observation_classification,
          at: capturedAt,
          event_hash: globalEvent.event_hash,
          previous_event_hash: globalEvent.previous_event_hash,
        },
      ],
    };
    witnessedRecord.integrity = { ...record.integrity, record_hash: null };
    witnessedRecord.integrity.record_hash = computeRecordHash(witnessedRecord);

    const resolved = resolveProposalPath(storageRoot, proposalId);
    if (!resolved.ok || !(await assertNotSymlink(resolved.target))) {
      return fail(WERR.WITNESS_WRITE_FAILED, 'proposal record path is no longer safe to write');
    }
    try {
      await atomicWriteJson(resolved.target, witnessedRecord);
    } catch (err) {
      return fail(WERR.WITNESS_WRITE_FAILED, String(err && err.message || err));
    }

    return {
      ok: true,
      idempotent: false,
      witnessed: true,
      proposal_id: proposalId,
      witness: packet,
      record: witnessedRecord,
    };
  }

  return { captureExecutionWitness };
}

/**
 * Record exactly one deterministic reconciliation verdict from the PERSISTED
 * execution result and the PERSISTED witness packet. Pure comparison — no
 * process, no network, no model, no credential. Idempotent on repeat.
 *
 * @param {object} request - UNTRUSTED. Only { storageRoot, proposalId } are read.
 * @param {object} [options]
 * @param {function(): string} [options.now] - injectable ISO-timestamp clock.
 */
export async function recordSemanticReconciliation(request, options = {}) {
  const req = validateRequest(request);
  if (!req.ok) return req;
  const { storageRoot, proposalId } = req;
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  const loaded = await loadTerminalExecution(storageRoot, proposalId);
  if (!loaded.ok) return loaded;
  const record = loaded.record;

  // One-shot idempotency: a persisted verdict is returned, never recomputed-and-rewritten.
  if (record.reconciliation) {
    if (record.witness && record.reconciliation.witness_hash === record.witness.witness_hash && computeReconciliationHash(record.reconciliation) === record.reconciliation.reconciliation_hash) {
      return {
        ok: true,
        idempotent: true,
        code: RERR.RECONCILIATION_ALREADY_RECORDED,
        proposal_id: proposalId,
        status: record.reconciliation.status,
        outcome_class: record.reconciliation.outcome_class,
        reconciliation: record.reconciliation,
        record,
      };
    }
    return fail(RERR.RECONCILIATION_IDENTITY_CONFLICT, 'a reconciliation exists but no longer binds to the persisted witness');
  }

  if (!record.witness) {
    return fail(RERR.WITNESS_NOT_CAPTURED, 'no witness has been captured for this proposal — reconciliation requires a persisted witness');
  }
  const witnessCheck = await verifyExecutionWitness(storageRoot, proposalId);
  if (!witnessCheck.ok) return witnessCheck;
  if (witnessCheck.valid !== true || witnessCheck.witnessed !== true) {
    return fail(WERR.WITNESS_INTEGRITY_FAILURE, JSON.stringify(witnessCheck.details || []));
  }

  const plan = record.execution.plan;
  const selected = selectWitnessProfile(plan);
  if (!selected.ok) return selected;
  const profile = selected.profile;
  if (profile.profile_id !== record.witness.witness_profile_id) {
    return fail(WERR.WITNESS_INTEGRITY_FAILURE, 'persisted witness profile does not match the plan-selected profile');
  }

  // ── One-shot exclusive claim (O_EXCL) — never deleted by this module ──────
  const claimPath = reconciliationClaimPath(storageRoot, proposalId);
  if (!(await assertNotSymlink(claimPath))) {
    return fail(RERR.CONCURRENT_RECONCILIATION_CONFLICT, 'reconciliation claim path is a symlink — refusing');
  }
  try {
    await mkdir(reconciliationsDir(storageRoot), { recursive: true });
    await writeFile(claimPath, JSON.stringify({ reconciliation_id: `rec-${proposalId}`, proposal_id: proposalId, claimed_at: now(), pid: process.pid }) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return fail(RERR.CONCURRENT_RECONCILIATION_CONFLICT, 'another caller already holds the reconciliation claim for this proposal');
    }
    return fail(RERR.RECONCILIATION_WRITE_FAILED, String(err && err.message || err));
  }

  // Post-claim re-read: the state we validated must still hold.
  const reread = await getPendingProposal(storageRoot, proposalId);
  if (!reread.ok || reread.record.integrity.record_hash !== record.integrity.record_hash || reread.record.reconciliation) {
    return fail(RERR.CONCURRENT_RECONCILIATION_CONFLICT, 'proposal changed between validation and claim');
  }

  // ── The single deterministic comparison ────────────────────────────────────
  const verdict = computeProfileReconciliation({
    profile,
    recordedResult: record.execution.result,
    witnessPacket: record.witness,
    plan,
  });

  const computedAt = now();
  const reconciliation = {
    reconciliation_version: RECONCILIATION_VERSION,
    reconciliation_id: `rec-${proposalId}`,
    proposal_id: proposalId,
    execution_id: record.execution.execution_id,
    execution_plan_hash: plan.plan_hash,
    execution_result_hash: record.execution.result_hash,
    witness_hash: record.witness.witness_hash,
    semantic_checksum: record.semantic_checksum,
    witness_profile_id: profile.profile_id,
    normalization_version: profile.normalization_version,
    status: verdict.status,
    outcome_class: verdict.outcome_class,
    indeterminate_reason: verdict.indeterminate_reason,
    divergence: verdict.divergence,
    compared_fields: verdict.compared_fields,
    bounded_claim: BOUNDED_RECONCILIATION_CLAIM,
    computed_at: computedAt,
    reconciliation_hash: null,
  };
  reconciliation.reconciliation_hash = computeReconciliationHash(reconciliation);

  let globalEvent;
  try {
    globalEvent = await appendGlobalEvent(storageRoot, {
      event_version: RECONCILIATION_EVENT_VERSION,
      type: verdict.status,
      proposal_id: proposalId,
      execution_id: record.execution.execution_id,
      plan_hash: plan.plan_hash,
      execution_result_hash: record.execution.result_hash,
      witness_hash: record.witness.witness_hash,
      semantic_checksum: record.semantic_checksum,
      reconciliation_hash: reconciliation.reconciliation_hash,
      outcome_class: verdict.outcome_class,
      indeterminate_reason: verdict.indeterminate_reason,
      at: computedAt,
    });
  } catch (err) {
    return fail(RERR.RECONCILIATION_WRITE_FAILED, String(err && err.message || err));
  }

  const reconciledRecord = {
    ...record,
    reconciliation,
    events: [
      ...record.events,
      {
        event_version: RECONCILIATION_EVENT_VERSION,
        type: verdict.status,
        proposal_id: proposalId,
        execution_id: record.execution.execution_id,
        plan_hash: plan.plan_hash,
        execution_result_hash: record.execution.result_hash,
        witness_hash: record.witness.witness_hash,
        semantic_checksum: record.semantic_checksum,
        reconciliation_hash: reconciliation.reconciliation_hash,
        outcome_class: verdict.outcome_class,
        indeterminate_reason: verdict.indeterminate_reason,
        at: computedAt,
        event_hash: globalEvent.event_hash,
        previous_event_hash: globalEvent.previous_event_hash,
      },
    ],
  };
  reconciledRecord.integrity = { ...record.integrity, record_hash: null };
  reconciledRecord.integrity.record_hash = computeRecordHash(reconciledRecord);

  const resolved = resolveProposalPath(storageRoot, proposalId);
  if (!resolved.ok || !(await assertNotSymlink(resolved.target))) {
    return fail(RERR.RECONCILIATION_WRITE_FAILED, 'proposal record path is no longer safe to write');
  }
  try {
    await atomicWriteJson(resolved.target, reconciledRecord);
  } catch (err) {
    return fail(RERR.RECONCILIATION_WRITE_FAILED, String(err && err.message || err));
  }

  return {
    ok: true,
    idempotent: false,
    reconciled: true,
    proposal_id: proposalId,
    status: verdict.status,
    outcome_class: verdict.outcome_class,
    reconciliation,
    record: reconciledRecord,
  };
}

/**
 * Read-only: current witness/reconciliation state of a proposal. Involves no
 * credential, no claim, no process — safe to call directly.
 */
export async function getSemanticReconciliationState(storageRoot, proposalId) {
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;
  return {
    ok: true,
    proposal_id: proposalId,
    state: record.state,
    witnessed: Boolean(record.witness),
    witness_hash: record.witness?.witness_hash ?? null,
    reconciled: Boolean(record.reconciliation),
    status: record.reconciliation?.status ?? null,
    outcome_class: record.reconciliation?.outcome_class ?? null,
    indeterminate_reason: record.reconciliation?.indeterminate_reason ?? null,
    record,
  };
}

/**
 * Verify a persisted reconciliation's integrity: the underlying record and
 * ledger, the witness binding, the reconciliation hash, the ledger event, and
 * — decisively — that the persisted verdict equals a fresh recomputation from
 * the persisted inputs. Never mutates anything, regardless of outcome.
 */
export async function verifySemanticReconciliation(storageRoot, proposalId) {
  const recordIntegrity = await verifyPendingProposal(storageRoot, proposalId);
  if (!recordIntegrity.ok) return recordIntegrity;
  const details = [];
  if (recordIntegrity.valid === false) {
    details.push(...(recordIntegrity.details || ['record_integrity_failure']));
  }
  const ledgerIntegrity = await verifyEventLedger(storageRoot);
  if (ledgerIntegrity.valid === false) {
    details.push('event_ledger_integrity_failure');
  }

  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;
  const reconciliation = record.reconciliation;
  if (!reconciliation) {
    return details.length > 0
      ? { ok: true, valid: false, error: RERR.RECONCILIATION_INTEGRITY_FAILURE, details }
      : { ok: true, valid: true, reconciled: false };
  }

  const witnessCheck = await verifyExecutionWitness(storageRoot, proposalId);
  if (witnessCheck.ok && (witnessCheck.valid !== true || witnessCheck.witnessed !== true)) {
    details.push('witness_integrity_failure');
  }

  if (reconciliation.reconciliation_version !== RECONCILIATION_VERSION) details.push('invalid_reconciliation_version');
  if (computeReconciliationHash(reconciliation) !== reconciliation.reconciliation_hash) details.push('reconciliation_hash_mismatch');
  if (reconciliation.proposal_id !== proposalId) details.push('reconciliation_proposal_mismatch');
  if (!Object.values(RECONCILIATION_STATUSES).includes(reconciliation.status)) details.push('unknown_reconciliation_status');
  if (!record.witness) {
    details.push('reconciliation_without_witness');
  } else {
    if (reconciliation.witness_hash !== record.witness.witness_hash) details.push('reconciliation_witness_binding_mismatch');
    if (record.execution && reconciliation.execution_result_hash !== record.execution.result_hash) details.push('reconciliation_result_binding_mismatch');

    // Recompute the verdict from persisted inputs — the persisted status must
    // be reproducible, not merely well-formed.
    const selected = selectWitnessProfile(record.execution?.plan);
    if (!selected.ok) {
      details.push('reconciliation_profile_unresolvable');
    } else {
      const recomputed = computeProfileReconciliation({
        profile: selected.profile,
        recordedResult: record.execution.result,
        witnessPacket: record.witness,
        plan: record.execution?.plan,
      });
      if (recomputed.status !== reconciliation.status) details.push('reconciliation_status_not_reproducible');
      if (recomputed.outcome_class !== reconciliation.outcome_class) details.push('reconciliation_outcome_not_reproducible');
      if (recomputed.indeterminate_reason !== reconciliation.indeterminate_reason) details.push('reconciliation_reason_not_reproducible');
    }
  }
  if (!record.events.some((e) => e.type === reconciliation.status && e.reconciliation_hash === reconciliation.reconciliation_hash)) {
    details.push('reconciliation_event_missing_or_mismatched');
  }

  if (details.length > 0) {
    return { ok: true, valid: false, error: RERR.RECONCILIATION_INTEGRITY_FAILURE, details };
  }
  return { ok: true, valid: true, reconciled: true };
}
