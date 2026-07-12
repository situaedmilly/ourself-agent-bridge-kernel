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
//   • allows a state transition outside the legal table in §3 of the spec;
//   • lets a corrupt record be misread as MISSION_NOT_FOUND (Correction 1);
//   • lets two concurrent mutations on the same mission_id silently
//     overwrite one another (Correction 1) — see lease law below.
//
// STORAGE
//   <storageRoot>/missions/<mission_id>.json   — canonical current record
//   <storageRoot>/missions/<mission_id>.lock    — O_EXCL single-writer claim
//     (created fresh per mutation, released in a finally block; never left
//     behind except as an explicit, inspectable stale-lease signal)
//   <storageRoot>/events.jsonl                 — shared hash-chained ledger
//   (reuses the same append-only event-ledger primitives as
//   persistence/pending-proposals.js; live runtime state is expected to live
//   outside the Git repository via an explicit storageRoot, never inside
//   logs/ by default — matching persistence/queue-store.js's PLANE LAW.)
//
// LEASE LAW (Correction 1 / F2 — single-writer protection per mission_id)
//   Every mutating operation (create, transition, assignExecutor,
//   replaceExecutor, recordInterruption, appendHistory) acquires an
//   exclusive per-mission lease via an O_EXCL claim file BEFORE reading or
//   writing the mission record, and releases it in a finally block. This is
//   the same durable, cross-process primitive persistence/queue-store.js
//   uses for its lease claims (an O_EXCL filesystem create is atomic across
//   processes on the same filesystem — no network coordination required).
//   A concurrent caller that loses the race receives a typed
//   MISSION_KERNEL_LEASE_HELD error, never a silently lost update. A lease
//   older than staleLeaseMs is reported as MISSION_KERNEL_LEASE_STALE and is
//   NEVER auto-reclaimed; only an explicit breakStaleLease() call — which
//   re-verifies staleness immediately before deleting — may clear it.

'use strict';

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  atomicWriteJson,
  appendGlobalEvent,
  assertNotSymlink,
  eventsLedgerPath,
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
  // Correction 1 additions:
  CORRUPT_RECORD: 'MISSION_KERNEL_CORRUPT_RECORD',
  CORRUPT_EVENT: 'MISSION_KERNEL_CORRUPT_EVENT',
  INTEGRITY_FAILURE: 'MISSION_KERNEL_INTEGRITY_FAILURE',
  LEASE_HELD: 'MISSION_KERNEL_LEASE_HELD',
  LEASE_STALE: 'MISSION_KERNEL_LEASE_STALE',
});

const SAFE_MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// A lease older than this is reported as stale rather than held. No
// automatic reclaim ever occurs — see LEASE LAW above.
const DEFAULT_STALE_LEASE_MS = 30_000;

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
  const lock = resolve(dir, `${missionId}.lock`);
  if (!target.startsWith(dir + sep) || !lock.startsWith(dir + sep)) {
    return { ok: false };
  }
  return { ok: true, dir, target, lock };
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
 * Verify the FULL shared events.jsonl hash chain — read-only, reports only,
 * never repairs. Mirrors persistence/pending-proposals.js's
 * verifyEventLedger() exactly (same shared ledger, same chain algorithm),
 * re-exported here for discoverability from the Mission Kernel surface.
 * Stops at the first broken line (malformed JSON, truncated final line, a
 * previous_event_hash mismatch, or a recomputed event_hash mismatch) and
 * reports where. Does not skip or repair a break to keep scanning — a
 * broken link makes every event after it unverifiable against this chain.
 * @param {string} storageRoot
 */
export async function verifyEventChain(storageRoot) {
  const raw = await readFile(eventsLedgerPath(storageRoot), 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  let previousHash = null;
  let missionEventCount = 0;
  for (let i = 0; i < lines.length; i++) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      return {
        ok: true,
        valid: false,
        error: MISSION_KERNEL_ERRORS.CORRUPT_EVENT,
        brokenAtLine: i,
        reason: i === lines.length - 1 ? 'truncated_final_line' : 'malformed_json',
        totalLines: lines.length,
      };
    }
    const { event_hash, ...rest } = event;
    if (rest.previous_event_hash !== previousHash) {
      return {
        ok: true,
        valid: false,
        error: MISSION_KERNEL_ERRORS.INTEGRITY_FAILURE,
        brokenAtLine: i,
        reason: 'previous_event_hash_mismatch',
        totalLines: lines.length,
      };
    }
    if (canonicalHash(rest) !== event_hash) {
      return {
        ok: true,
        valid: false,
        error: MISSION_KERNEL_ERRORS.INTEGRITY_FAILURE,
        brokenAtLine: i,
        reason: 'event_hash_mismatch',
        totalLines: lines.length,
      };
    }
    if (event.event_version === MISSION_EVENT_VERSION) missionEventCount++;
    previousHash = event_hash;
  }
  return { ok: true, valid: true, eventCount: lines.length, missionEventCount };
}

/**
 * Construct a Mission Kernel store bound to a storageRoot. Never defaults to
 * a path inside the Git repository — the caller must supply one explicitly
 * (tests use an isolated temp directory; production supplies a runtime path
 * outside the repo, matching queue-store.js's PLANE LAW).
 * @param {{ storageRoot: string, staleLeaseMs?: number }} options
 */
export function createMissionKernelStore(options) {
  if (!options || typeof options.storageRoot !== 'string' || options.storageRoot.length === 0) {
    throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'storageRoot is required');
  }
  const storageRoot = options.storageRoot;
  const staleLeaseMs = Number.isInteger(options.staleLeaseMs) ? options.staleLeaseMs : DEFAULT_STALE_LEASE_MS;

  async function recordEvent(type, missionId, payload) {
    return appendGlobalEvent(storageRoot, {
      event_version: MISSION_EVENT_VERSION,
      type,
      mission_id: missionId,
      payload,
    });
  }

  /**
   * Acquire an exclusive per-mission lease via an O_EXCL claim file. Fails
   * closed: LEASE_HELD if another holder currently owns it, LEASE_STALE if
   * the existing claim is older than staleLeaseMs (never auto-reclaimed —
   * the caller must call breakStaleLease() explicitly).
   */
  async function acquireLease(missionId) {
    const resolved = resolveMissionPath(storageRoot, missionId);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);
    await mkdir(resolved.dir, { recursive: true });
    const holderId = `holder-${randomBytes(8).toString('hex')}`;
    const claim = { mission_id: missionId, holder_id: holderId, acquired_at: Date.now() };
    try {
      await writeFile(resolved.lock, JSON.stringify(claim), { flag: 'wx' });
      return { lockPath: resolved.lock, holderId };
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const raw = await readFile(resolved.lock, 'utf8').catch(() => null);
        let existing = null;
        try {
          existing = raw ? JSON.parse(raw) : null;
        } catch {
          existing = null;
        }
        const age = existing && typeof existing.acquired_at === 'number' ? Date.now() - existing.acquired_at : null;
        if (existing && age !== null && age > staleLeaseMs) {
          throw fail(
            MISSION_KERNEL_ERRORS.LEASE_STALE,
            `lease on mission ${missionId} is stale (age ${age}ms > ${staleLeaseMs}ms) — call breakStaleLease() explicitly, no automatic reclaim`
          );
        }
        throw fail(MISSION_KERNEL_ERRORS.LEASE_HELD, `mission ${missionId} is locked by another in-flight mutation`);
      }
      throw err;
    }
  }

  /** Release a held lease. Best-effort on the unlink itself — a lease that
   * is already gone by release time is not an error (e.g. broken as stale
   * by another caller after this holder's mutation already committed). */
  async function releaseLease(lockPath) {
    await unlink(lockPath).catch(() => {});
  }

  /**
   * Explicitly clear a stale lease. Re-verifies staleness immediately before
   * deleting, closing the race where the original holder released the lease
   * (or a fresh lease was legitimately re-acquired) between detection and
   * this call. Throws LEASE_HELD if the lease is not actually stale.
   */
  async function breakStaleLease(missionId) {
    const resolved = resolveMissionPath(storageRoot, missionId);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);
    const raw = await readFile(resolved.lock, 'utf8').catch(() => null);
    if (raw === null) return { ok: true, cleared: false, reason: 'no_lease_present' };
    let existing = null;
    try {
      existing = JSON.parse(raw);
    } catch {
      // An unparseable lock file is itself corrupt — treat it as breakable,
      // never silently trusted or repaired in place.
      await unlink(resolved.lock).catch(() => {});
      return { ok: true, cleared: true, reason: 'corrupt_lease_cleared' };
    }
    const age = typeof existing.acquired_at === 'number' ? Date.now() - existing.acquired_at : null;
    if (age === null || age <= staleLeaseMs) {
      throw fail(MISSION_KERNEL_ERRORS.LEASE_HELD, `lease on mission ${missionId} is not stale (age ${age}ms)`);
    }
    await unlink(resolved.lock).catch(() => {});
    return { ok: true, cleared: true, reason: 'stale_lease_cleared', age };
  }

  /**
   * Run `fn` while holding the exclusive lease for missionId. Guarantees
   * release in a finally block regardless of how `fn` exits.
   */
  async function withLease(missionId, fn) {
    const lease = await acquireLease(missionId);
    try {
      return await fn();
    } finally {
      await releaseLease(lease.lockPath);
    }
  }

  /**
   * Create a new Mission Kernel record. Fails closed on invalid shape or a
   * mission_id collision (missions are append-only identities; ids are never
   * reassigned). Lease-guarded so two concurrent create() calls for the same
   * mission_id cannot both believe they won.
   * @param {object} kernel — must include mission_id, state ('INITIALIZED'
   *   unless caller has a documented reason otherwise), and intent.purpose.
   */
  async function create(kernel) {
    if (!validateKernelShape(kernel)) {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE);
    }
    const resolved = resolveMissionPath(storageRoot, kernel.mission_id);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);

    return withLease(kernel.mission_id, async () => {
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
    });
  }

  /**
   * Retrieve a Mission Kernel record by mission_id, or null if not found.
   * Correction 1 / F1: a corrupt (malformed-JSON, or JSON that fails shape
   * validation) record throws a typed CORRUPT_RECORD error — it is NEVER
   * interpreted as "not found", and it is never silently repaired.
   */
  async function get(missionId) {
    const resolved = resolveMissionPath(storageRoot, missionId);
    if (!resolved.ok) throw fail(MISSION_KERNEL_ERRORS.INVALID_MISSION_ID);
    if (!(await assertNotSymlink(resolved.target))) {
      throw fail(MISSION_KERNEL_ERRORS.SYMLINK_REJECTED);
    }
    const raw = await readFile(resolved.target, 'utf8').catch(() => null);
    if (raw === null) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw fail(MISSION_KERNEL_ERRORS.CORRUPT_RECORD, `mission record ${missionId} is malformed or truncated JSON`);
    }
    if (!validateKernelShape(parsed)) {
      throw fail(MISSION_KERNEL_ERRORS.CORRUPT_RECORD, `mission record ${missionId} failed shape validation on read`);
    }
    return parsed;
  }

  /** Internal: read-modify-write, called only while the caller already holds the lease. */
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
   * present in LEGAL_TRANSITIONS is rejected without mutation. Lease-guarded
   * end-to-end: the read, the legality check, and the write all happen while
   * holding the mission's exclusive lease.
   * @param {string} missionId
   * @param {string} nextState
   * @param {object} transitionRecord — free-form context (reason, actor, etc.)
   */
  async function transition(missionId, nextState, transitionRecord = {}) {
    if (!MISSION_STATES.includes(nextState)) {
      throw fail(MISSION_KERNEL_ERRORS.ILLEGAL_TRANSITION, `unknown state: ${nextState}`);
    }
    return withLease(missionId, async () => {
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
    });
  }

  /**
   * Assign an executor to a mission. Does not imply the executor inherits
   * any prior executor's permissions — each assignment is explicit.
   */
  async function assignExecutor(missionId, assignment) {
    if (!assignment || typeof assignment !== 'object' || typeof assignment.executor_id !== 'string') {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'assignment.executor_id is required');
    }
    return withLease(missionId, async () => {
      const updated = await writeUpdatedRecord(missionId, (record) => ({
        ...record,
        current_executor: { ...assignment },
        history: [...record.history, { type: 'EXECUTOR_ASSIGNED', executor_id: assignment.executor_id }],
      }));
      await recordEvent('EXECUTOR_ASSIGNED', missionId, { executor_id: assignment.executor_id });
      return updated;
    });
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
    return withLease(missionId, async () => {
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
    });
  }

  /**
   * Record an interruption. Append-only: interruption_state reflects the
   * MOST RECENT interruption; the full history lives in `history`.
   */
  async function recordInterruption(missionId, interruption) {
    if (!interruption || typeof interruption !== 'object' || typeof interruption.detected_at !== 'string') {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'interruption.detected_at is required');
    }
    return withLease(missionId, async () => {
      const entry = { type: 'INTERRUPTION_RECORDED', ...interruption };
      const updated = await writeUpdatedRecord(missionId, (record) => ({
        ...record,
        interruption_state: { ...interruption },
        history: [...record.history, entry],
      }));
      await recordEvent('INTERRUPTION_RECORDED', missionId, interruption);
      return updated;
    });
  }

  /** Append a free-form entry to the mission's append-only history log. */
  async function appendHistory(missionId, entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') {
      throw fail(MISSION_KERNEL_ERRORS.INVALID_KERNEL_SHAPE, 'entry.type is required');
    }
    return withLease(missionId, async () => {
      const updated = await writeUpdatedRecord(missionId, (record) => ({
        ...record,
        history: [...record.history, entry],
      }));
      await recordEvent('HISTORY_APPENDED', missionId, entry);
      return updated;
    });
  }

  /**
   * Produce a HandoffPacket snapshot for the next executor. Read-only —
   * does not mutate the mission record, so it does not take a lease.
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
    breakStaleLease,
    verifyEventChain: () => verifyEventChain(storageRoot),
  });
}
