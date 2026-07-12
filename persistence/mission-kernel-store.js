// persistence/mission-kernel-store.js
// ── Mission Kernel v0: minimal durable persistence layer ────────────────────
//
// PURPOSE
//   Give a Mission Kernel record (the durable primitive beneath OURSELFROOT —
//   Mission, not Agent session) crash-safe, integrity-hashed, append-only
//   storage with fail-closed lifecycle-transition enforcement.
//
// SPECIFICATION BINDING
//   Implements specifications/mission-kernel.v0.schema.md
//   class: SPECIFICATION, status: INITIAL_DRAFT
//   sha256: 5bcf0e0fd4ea700a11b41a4496fe4d8145115658c52cad710b43cb9aea00114a
//   This module conforms to that EXACT draft only. If a required behavior is
//   not expressible without changing the specification, this module must
//   fail closed and report SPECIFICATION_DEVIATION rather than silently
//   diverge from the bound draft (see verifySpecificationBinding()).
//
// HARD INVARIANTS (this module NEVER)
//   • grants authority, verifies semantic truth, or approves evidence;
//   • executes platform actions or routes models;
//   • infers human consent;
//   • promotes any record — getPromotionBoundaryStatus() only ever REPORTS,
//     it never authorizes, infers, or performs promotion;
//   • mutates sealed doctrine or writes outside its own storageRoot;
//   • silently repairs a corrupted record or rewrites specification text;
//   • allows a state transition outside the legal table in §3 of the spec.
//
// STORAGE
//   <storageRoot>/missions/<mission_id>.json   — canonical current record
//   <storageRoot>/events.jsonl                 — shared hash-chained ledger
//   (reuses the same append-only event-ledger primitives as
//   persistence/pending-proposals.js; live runtime state is expected to live
//   outside the Git repository via an explicit storageRoot, never inside
//   logs/ by default — matching persistence/queue-store.js's PLANE LAW.)

'use strict';

import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import {
  atomicWriteJson,
  appendGlobalEvent,
  assertNotSymlink,
} from './pending-proposals.js';
import { canonicalHash } from './canonical-json.js';

export const MISSION_KERNEL_VERSION = 'ourself.mission-kernel.v0';
export const MISSION_EVENT_VERSION = 'ourself.mission-kernel-event.v0';

export const SPECIFICATION_BINDING = Object.freeze({
  path: 'specifications/mission-kernel.v0.schema.md',
  class: 'SPECIFICATION',
  status: 'INITIAL_DRAFT',
  sha256: '5bcf0e0fd4ea700a11b41a4496fe4d8145115658c52cad710b43cb9aea00114a',
  implementation_claim: 'CONFORMS_TO_THIS_EXACT_DRAFT_ONLY',
});

export const MISSION_STATES = Object.freeze([
  'INITIALIZED',
  'ORIENTED',
  'EXECUTING',
  'PAUSED',
  'INTERRUPTED',
  'COMPLETED',
  'FAILED',
  'SEALED',
]);

// Legal transition table — spec §3. Any pair not listed here is illegal.
export const LEGAL_TRANSITIONS = Object.freeze({
  INITIALIZED: Object.freeze(['ORIENTED', 'FAILED']),
  ORIENTED: Object.freeze(['EXECUTING', 'PAUSED', 'FAILED']),
  EXECUTING: Object.freeze(['PAUSED', 'INTERRUPTED', 'COMPLETED', 'FAILED']),
  PAUSED: Object.freeze(['ORIENTED', 'EXECUTING', 'INTERRUPTED', 'FAILED']),
  INTERRUPTED: Object.freeze(['ORIENTED', 'PAUSED', 'FAILED']),
  COMPLETED: Object.freeze(['SEALED']),
  FAILED: Object.freeze([]),
  SEALED: Object.freeze([]),
});

export const MISSION_KERNEL_ERRORS = Object.freeze({
  INVALID_MISSION_ID: 'INVALID_MISSION_ID',
  INVALID_KERNEL_SHAPE: 'INVALID_KERNEL_SHAPE',
  MISSION_NOT_FOUND: 'MISSION_NOT_FOUND',
  MISSION_ALREADY_EXISTS: 'MISSION_ALREADY_EXISTS',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  SYMLINK_REJECTED: 'SYMLINK_REJECTED',
  SPECIFICATION_DEVIATION: 'SPECIFICATION_DEVIATION',
});

const SAFE_MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function missionsDir(storageRoot) {
  return join(storageRoot, 'missions');
}

/** Resolve and validate the on-disk path for a mission ID, staying strictly
 * inside <storageRoot>/missions. Rejects unsafe IDs before any filesystem call. */
function resolveMissionPath(storageRoot, missionId) {
  if (typeof missionId !== 'string' || !SAFE_MISSION_ID.test(missionId)) {
    return { ok: false };
  }
  const dir = resolve(missionsDir(storageRoot));
  const target = resolve(dir, `${missionId}.json`);
  if (!target.startsWith(dir + sep)) {
    return { ok: false };
  }
  return { ok: true, dir, target };
}

function fail(code, reason) {
  const err = new Error(reason || code);
  err.code = code;
  return err;
}

/** Minimal structural validation of a Mission Kernel record shape. This is
 * schema-conformance only — it never evaluates semantic truth. */
function validateKernelShape(kernel) {
  if (!kernel || typeof kernel !== 'object') return false;
  if (typeof kernel.mission_id !== 'string' || !SAFE_MISSION_ID.test(kernel.mission_id)) return false;
  if (!MISSION_STATES.includes(kernel.state)) return false;
  if (!kernel.intent || typeof kernel.intent !== 'object') return false;
  if (typeof kernel.intent.purpose !== 'string' || kernel.intent.purpose.length === 0) return false;
  return true;
}

/**
 * Confirm this module still points at the exact specification digest it was
 * built against. Fails closed (SPECIFICATION_DEVIATION) rather than silently
 * operating against a changed specification file.
 * @param {string} specFileAbsPath — absolute path to mission-kernel.v0.schema.md
 */
export async function verifySpecificationBinding(specFileAbsPath) {
  const raw = await readFile(specFileAbsPath, 'utf8');
  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== SPECIFICATION_BINDING.sha256) {
    return {
      ok: false,
      status: 'STOPPED',
      reason: 'SPECIFICATION_DEVIATION',
      authority_required: 'FOUNDER_REVIEW',
      expected_sha256: SPECIFICATION_BINDING.sha256,
      actual_sha256: digest,
    };
  }
  return { ok: true, sha256: digest };
}

/**
 * Construct a Mission Kernel store bound to a storageRoot. Never defaults to
 * a path inside the Git repository — the caller must supply one explicitly
 * (tests use an isolated temp directory; production supplies a runtime path
 * outside the repo, matching queue-store.js's PLANE LAW).
 * @param {{ storageRoot: string }} options
 */
export function createMissionKernelStore(options) {
  if (!options || typeof options.storageRoot !== 'string' || options.storageRoot.length === 0) {
    throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'storageRoot is required');
  }
  const storageRoot = options.storageRoot;

  async function recordEvent(type, missionId, payload) {
    return appendGlobalEvent(storageRoot, {
      event_version: MISSION_EVENT_VERSION,
      type,
      mission_id: missionId,
      payload,
    });
  }

  /**
   * Create a new Mission Kernel record. Fails closed on invalid shape or a
   * mission_id collision (missions are append-only identities; ids are never
   * reassigned).
   * @param {object} kernel — must include mission_id, state ('INITIALIZED'
   *   unless caller has a documented reason otherwise), and intent.purpose.
   */
  async function create(kernel) {
    if (!validateKernelShape(kernel)) {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE);
    }
    const resolved = resolveMissionPath(storageRoot, kernel.mission_id);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);
    if (!(await assertNotSymlink(resolved.target))) {
      throw fail(MISSION_KERNEL_ERRORS.SYMLINK_REJECTED);
    }
    const existing = await readFile(resolved.target, 'utf8').catch(() => null);
    if (existing !== null) {
      throw fail(MISSION_KERNEL_ERRORS.MISSION_ALREADY_EXISTS);
    }

    const record = {
      ...kernel,
      kernel_version: MISSION_KERNEL_VERSION,
      specification_binding: SPECIFICATION_BINDING,
      executor_history: Array.isArray(kernel.executor_history) ? kernel.executor_history : [],
      history: [],
      interruption_state: kernel.interruption_state ?? null,
      promotion_boundary: {
        status: 'NOT_CROSSED',
        validator_authority: 'NONE',
        evidence_state: kernel.promotion_boundary?.evidence_state ?? 'UNREPORTED',
        reason: 'Explicit human authorization is required for promotion.',
      },
      record_hash: null,
    };
    delete record.record_hash;
    record.record_hash = canonicalHash({ ...record, record_hash: undefined });

    await atomicWriteJson(resolved.target, record);
    await recordEvent('MISSION_CREATED', kernel.mission_id, {
      state: record.state,
      record_hash: record.record_hash,
    });
    return record;
  }

  /** Retrieve a Mission Kernel record by mission_id, or null if not found. */
  async function get(missionId) {
    const resolved = resolveMissionPath(storageRoot, missionId);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);
    if (!(await assertNotSymlink(resolved.target))) {
      throw fail(MISSION_KERNEL_ERRORS.SYMLINK_REJECTED);
    }
    const raw = await readFile(resolved.target, 'utf8').catch(() => null);
    if (raw === null) return null;
    return JSON.parse(raw);
  }

  async function writeUpdatedRecord(missionId, updater) {
    const resolved = resolveMissionPath(storageRoot, missionId);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);
    const current = await get(missionId);
    if (current === null) throw fail(MISSION_KERNEL_ERRORS.MISSION_NOT_FOUND);

    const next = updater(current);
    if (!validateKernelShape(next)) {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE);
    }
    delete next.record_hash;
    next.record_hash = canonicalHash({ ...next, record_hash: undefined });
    await atomicWriteJson(resolved.target, next);
    return next;
  }

  /**
   * Transition a mission to a new lifecycle state. Fail-closed: any pair not
   * present in LEGAL_TRANSITIONS is rejected without mutation.
   * @param {string} missionId
   * @param {string} nextState
   * @param {object} transitionRecord — free-form context (reason, actor, etc.)
   */
  async function transition(missionId, nextState, transitionRecord = {}) {
    if (!MISSION_STATES.includes(nextState)) {
      throw fail(MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION, `unknown state: ${nextState}`);
    }
    const current = await get(missionId);
    if (current === null) throw fail(MISSION_KERNEL_ERRORS.MISSION_NOT_FOUND);

    const allowed = LEGAL_TRANSITIONS[current.state] ?? [];
    if (!allowed.includes(nextState)) {
      throw fail(
        MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION,
        `${current.state} -> ${nextState} is not a legal transition`
      );
    }

    const entry = {
      type: 'STATE_TRANSITION',
      from: current.state,
      to: nextState,
      ...transitionRecord,
    };

    const updated = await writeUpdatedRecord(missionId, (record) => ({
      ...record,
      state: nextState,
      history: [...record.history, entry],
    }));
    await recordEvent('MISSION_TRANSITIONED', missionId, entry);
    return updated;
  }

  /**
   * Assign an executor to a mission. Does not imply the executor inherits
   * any prior executor's permissions — each assignment is explicit.
   */
  async function assignExecutor(missionId, assignment) {
    if (!assignment || typeof assignment !== 'object' || typeof assignment.executor_id !== 'string') {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'assignment.executor_id is required');
    }
    const updated = await writeUpdatedRecord(missionId, (record) => ({
      ...record,
      current_executor: { ...assignment },
      history: [...record.history, { type: 'EXECUTOR_ASSIGNED', executor_id: assignment.executor_id }],
    }));
    await recordEvent('EXECUTOR_ASSIGNED', missionId, { executor_id: assignment.executor_id });
    return updated;
  }

  /**
   * Replace the current executor. Records a release entry for the outgoing
   * executor in executor_history (append-only) before assigning the new one.
   */
  async function replaceExecutor(missionId, replacementRecord) {
    if (
      !replacementRecord ||
      typeof replacementRecord !== 'object' ||
      typeof replacementRecord.next_executor !== 'object' ||
      typeof replacementRecord.next_executor.executor_id !== 'string'
    ) {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'replacementRecord.next_executor.executor_id is required');
    }
    const updated = await writeUpdatedRecord(missionId, (record) => {
      const releaseEntry = {
        executor_id: record.current_executor?.executor_id ?? null,
        released_at: replacementRecord.released_at ?? null,
        drift_classification: replacementRecord.drift_classification ?? 'UNCLASSIFIED',
        evidence_produced: replacementRecord.evidence_produced ?? [],
      };
      return {
        ...record,
        current_executor: { ...replacementRecord.next_executor },
        executor_history: [...record.executor_history, releaseEntry],
        history: [
          ...record.history,
          { type: 'EXECUTOR_REPLACED', released: releaseEntry, assigned: replacementRecord.next_executor.executor_id },
        ],
      };
    });
    await recordEvent('EXECUTOR_REPLACED', missionId, {
      next_executor_id: replacementRecord.next_executor.executor_id,
      drift_classification: replacementRecord.drift_classification ?? 'UNCLASSIFIED',
    });
    return updated;
  }

  /**
   * Record an interruption. Append-only: interruption_state reflects the
   * MOST RECENT interruption; the full history lives in `history`.
   */
  async function recordInterruption(missionId, interruption) {
    if (!interruption || typeof interruption !== 'object' || typeof interruption.detected_at !== 'string') {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'interruption.detected_at is required');
    }
    const entry = { type: 'INTERRUPTION_RECORDED', ...interruption };
    const updated = await writeUpdatedRecord(missionId, (record) => ({
      ...record,
      interruption_state: { ...interruption },
      history: [...record.history, entry],
    }));
    await recordEvent('INTERRUPTION_RECORDED', missionId, interruption);
    return updated;
  }

  /** Append a free-form entry to the mission's append-only history log. */
  async function appendHistory(missionId, entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'entry.type is required');
    }
    const updated = await writeUpdatedRecord(missionId, (record) => ({
      ...record,
      history: [...record.history, entry],
    }));
    await recordEvent('HISTORY_APPENDED', missionId, entry);
    return updated;
  }

  /**
   * Produce a HandoffPacket snapshot for the next executor. Read-only —
   * does not mutate the mission record.
   */
  async function createHandoffPacket(missionId, targetExecutorType) {
    const current = await get(missionId);
    if (current === null) throw fail(MISSION_KERNEL_ERRORS.MISSION_NOT_FOUND);

    return {
      handoff_id: `handoff-${missionId}-${current.history.length}`,
      from_executor: current.current_executor?.executor_id ?? null,
      to_executor_type: targetExecutorType ?? null,
      mission_state_snapshot: {
        sealed_intent: current.intent,
        current_observed_state: current.state,
        completed_work: current.history
          .filter((h) => h.type === 'STATE_TRANSITION' && h.to === 'COMPLETED')
          .map((h) => h.reason ?? 'completed'),
        pending_work: current.history
          .filter((h) => h.type === 'STATE_TRANSITION')
          .slice(-1)
          .map((h) => h.to),
        decisions_pending: current.interruption_state ? ['review_interruption'] : [],
        evidence_checksum: current.record_hash,
      },
      next_executor_readiness_checklist: [
        'executor MUST re-read sealed intent',
        'executor MUST compare observed state vs. preconditions',
        'executor MUST classify drift',
        'executor MUST request human gate if drift is failure-class',
        "executor MUST NOT resume prior executor's work without explicit re-assignment",
      ],
    };
  }

  /**
   * Report — never decide — the Promotion Boundary status for a mission.
   * This method NEVER returns a value asserting promotion has occurred or
   * is permitted; see spec §6 / HARD INVARIANTS above.
   */
  async function getPromotionBoundaryStatus(missionId) {
    const current = await get(missionId);
    if (current === null) throw fail(MISSION_KERNEL_ERRORS.MISSION_NOT_FOUND);
    return {
      status: 'NOT_CROSSED',
      validator_authority: 'NONE',
      evidence_state: current.promotion_boundary?.evidence_state ?? 'UNREPORTED',
      reason: 'Explicit human authorization is required for promotion.',
    };
  }

  /** Verify the mission's stored record_hash matches its own content. */
  async function verifyIntegrity(missionId) {
    const current = await get(missionId);
    if (current === null) throw fail(MISSION_KERNEL_ERRORS.MISSION_NOT_FOUND);
    const { record_hash, ...rest } = current;
    const recomputed = canonicalHash({ ...rest, record_hash: undefined });
    return { ok: recomputed === record_hash, stored: record_hash, recomputed };
  }

  return Object.freeze({
    storageRoot,
    create,
    get,
    transition,
    assignExecutor,
    replaceExecutor,
    recordInterruption,
    appendHistory,
    createHandoffPacket,
    getPromotionBoundaryStatus,
    verifyIntegrity,
  });
}
