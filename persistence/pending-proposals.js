// persistence/pending-proposals.js
// ── T-030: Durable Pending-Proposal Persistence for OURSELF Æ Proposals ─────
//
// PURPOSE
//   Convert a valid ourself.ae-kernel.v1 review result that has already
//   reached ACCEPTED_FOR_REVIEW into durable, append-only, auditable
//   institutional state — WITHOUT granting any additional authority.
//
// FOUNDATIONAL DISTINCTION (enforced by this module)
//   ACCEPTED_FOR_REVIEW  ≠  PERSISTED_PENDING  ≠  AUTHORIZED  ≠  EXECUTABLE
//
//   Persistence records institutional existence only. It never authorizes,
//   never consumes a HUMAN-TURN decision, and never executes anything.
//
// HARD INVARIANTS (this module NEVER)
//   • authorizes a proposal;
//   • consumes a HUMAN-TURN decision;
//   • executes a proposal;
//   • writes outside its own storageRoot;
//   • follows a symlink when reading or writing a proposal record;
//   • silently repairs a corrupted record.
//
// STORAGE LAYOUT (relative to the caller-supplied storageRoot)
//   <storageRoot>/proposals/<proposalId>.json  — one durable record per proposal,
//                                                 written via temp-file + atomic rename.
//   <storageRoot>/events.jsonl                  — global hash-chained append-only
//                                                 ledger of PROPOSAL_PERSISTED events,
//                                                 used to detect reordering/truncation.
//
// REQUIRED REJECTION / RESULT CODES
//   INVALID_REVIEW_RESULT · PROPOSAL_NOT_ACCEPTED · EXECUTION_ALREADY_PERFORMED ·
//   HUMAN_TURN_INVARIANT_VIOLATION · INVALID_PROTOCOL · INVALID_SEMANTIC_CHECKSUM ·
//   UNKNOWN_EXECUTION_CLASS · PROPOSAL_IDENTITY_INCOMPLETE · PROPOSAL_ALREADY_PERSISTED ·
//   PROPOSAL_IDENTITY_CONFLICT · PERSISTENCE_BOUNDARY_VIOLATION ·
//   PERSISTENCE_WRITE_FAILED · PERSISTED_RECORD_INVALID ·
//   PERSISTED_RECORD_INTEGRITY_FAILURE · PROPOSAL_NOT_FOUND ·
//   ROUTE_PLAN_PACKET_MISMATCH

'use strict';

import { mkdir, readFile, writeFile, rename, unlink, lstat, readdir, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { EXECUTION_CLASSES, EXECUTION_CLASS_NAMES } from '../tools/execution-classes.js';
import { computeSemanticChecksum } from '../adapters/ourself-intake.js';
import { canonicalHash } from './canonical-json.js';

export const RECORD_VERSION = 'ourself.pending-proposal.v1';
export const EVENT_VERSION = 'ourself.pending-proposal-event.v1';

export const PENDING_PROPOSAL_ERRORS = Object.freeze({
  INVALID_REVIEW_RESULT: 'INVALID_REVIEW_RESULT',
  PROPOSAL_NOT_ACCEPTED: 'PROPOSAL_NOT_ACCEPTED',
  EXECUTION_ALREADY_PERFORMED: 'EXECUTION_ALREADY_PERFORMED',
  HUMAN_TURN_INVARIANT_VIOLATION: 'HUMAN_TURN_INVARIANT_VIOLATION',
  INVALID_PROTOCOL: 'INVALID_PROTOCOL',
  INVALID_SEMANTIC_CHECKSUM: 'INVALID_SEMANTIC_CHECKSUM',
  UNKNOWN_EXECUTION_CLASS: 'UNKNOWN_EXECUTION_CLASS',
  PROPOSAL_IDENTITY_INCOMPLETE: 'PROPOSAL_IDENTITY_INCOMPLETE',
  PROPOSAL_ALREADY_PERSISTED: 'PROPOSAL_ALREADY_PERSISTED',
  PROPOSAL_IDENTITY_CONFLICT: 'PROPOSAL_IDENTITY_CONFLICT',
  PERSISTENCE_BOUNDARY_VIOLATION: 'PERSISTENCE_BOUNDARY_VIOLATION',
  PERSISTENCE_WRITE_FAILED: 'PERSISTENCE_WRITE_FAILED',
  PERSISTED_RECORD_INVALID: 'PERSISTED_RECORD_INVALID',
  PERSISTED_RECORD_INTEGRITY_FAILURE: 'PERSISTED_RECORD_INTEGRITY_FAILURE',
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  ROUTE_PLAN_PACKET_MISMATCH: 'ROUTE_PLAN_PACKET_MISMATCH',
});

const EXPECTED_PROTOCOL = 'ourself.ae-kernel.v1';

// Bare filename segment only — no '/', no '\', no control characters. This
// alone prevents path traversal: even a value of ".." becomes the harmless
// filename "...json" once suffixed, never a second path segment.
const SAFE_PROPOSAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function proposalsDir(storageRoot) {
  return join(storageRoot, 'proposals');
}

// Exported so T-031 (persistence/human-turn-decisions.js) can append decision
// events to the SAME store-wide ledger rather than inventing a second one.
export function eventsLedgerPath(storageRoot) {
  return join(storageRoot, 'events.jsonl');
}

/**
 * Resolve and validate the on-disk path for a proposal ID, staying strictly
 * inside <storageRoot>/proposals. Rejects unsafe IDs before any filesystem call.
 */
export function resolveProposalPath(storageRoot, proposalId) {
  if (typeof proposalId !== 'string' || !SAFE_PROPOSAL_ID.test(proposalId)) {
    return { ok: false };
  }
  const dir = resolve(proposalsDir(storageRoot));
  const target = resolve(dir, `${proposalId}.json`);
  if (!target.startsWith(dir + sep)) {
    return { ok: false };
  }
  return { ok: true, dir, target };
}

/** Reject a path if it exists and is a symlink — never follow it. */
export async function assertNotSymlink(path) {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return false;
  } catch {
    // does not exist — fine, nothing to reject
  }
  return true;
}

// Exported (with the three helpers above) so T-031 can extend the SAME
// per-proposal record and store-wide event ledger — see the module header:
// "Prefer... same authoritative event ledger" rather than a second storage root.
export async function atomicWriteJson(path, data) {
  const dir = path.slice(0, path.lastIndexOf(sep));
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const body = JSON.stringify(data, null, 2);
  await writeFile(tmp, body, 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Append one hash-chained line to the store-wide event ledger. Returns the event's hash. */
export async function appendGlobalEvent(storageRoot, eventWithoutHash) {
  const ledgerPath = eventsLedgerPath(storageRoot);
  await mkdir(storageRoot, { recursive: true });
  const raw = await readFile(ledgerPath, 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  let previousEventHash = null;
  if (lines.length > 0) {
    try {
      previousEventHash = JSON.parse(lines[lines.length - 1]).event_hash ?? null;
    } catch {
      previousEventHash = null;
    }
  }
  const withPrev = { ...eventWithoutHash, previous_event_hash: previousEventHash };
  const eventHash = canonicalHash(withPrev);
  const full = { ...withPrev, event_hash: eventHash };
  await appendFile(ledgerPath, JSON.stringify(full) + '\n');
  return full;
}

function validateReviewResultShape(reviewResult) {
  if (!reviewResult || typeof reviewResult !== 'object') return false;
  if (!reviewResult.proposal || typeof reviewResult.proposal !== 'object') return false;
  return true;
}

function extractIdentity(proposal) {
  const packet = proposal?.data?.packet;
  const routePlan = proposal?.data?.routePlan;
  const requestedExecution = proposal?.data?.requestedExecution;
  const origin = proposal?.origin;
  if (!packet || !routePlan || !requestedExecution || !origin) return null;
  if (!packet.packet_id || !packet.route || !packet.execution_class || !packet.created) return null;
  if (!origin.self || !origin.source) return null;
  if (!requestedExecution.class) return null;
  return { packet, routePlan, requestedExecution, origin };
}

function computeIdentityBindingHash({ protocol, semanticChecksum, packet, origin }) {
  return canonicalHash({
    protocol,
    semantic_checksum: semanticChecksum,
    proposal_id: packet.packet_id,
    route: packet.route,
    execution_class: packet.execution_class,
    origin_self: origin.self,
    origin_source: origin.source,
    packet_created: packet.created,
  });
}

/** Exported so T-031 can recompute an updated record's hash identically after a decision is applied. */
export function computeRecordHash(record) {
  const { integrity, ...rest } = record;
  const { record_hash, ...restIntegrity } = integrity;
  return canonicalHash({ ...rest, integrity: restIntegrity });
}

/**
 * Persist a proposal that has already reached ACCEPTED_FOR_REVIEW as durable,
 * institutional PERSISTED_PENDING state. Grants no authority. Never executes.
 *
 * @param {string} storageRoot - bounded directory this store owns exclusively.
 * @param {object} reviewResult - the exact { protocol, status, execution_performed,
 *   human_turn_required, proposal } result produced by the kernel adapter / runner.
 * @param {object} [options]
 * @param {string} [options.admittedAt] - ISO timestamp; defaults to persist-time now.
 * @param {string} [options.kernelHead] - kernel repo HEAD at admission time.
 * @param {string} [options.controlPlaneHead] - control-plane repo HEAD at admission time.
 * @param {string} [options.semanticChecksum] - the original envelope's semantic_checksum,
 *   if the caller has it, to be verified against recomputation.
 * @returns {Promise<object>} result object; see PENDING_PROPOSAL_ERRORS for error shapes.
 */
export async function persistPendingProposal(storageRoot, reviewResult, options = {}) {
  if (!validateReviewResultShape(reviewResult)) {
    return fail(PENDING_PROPOSAL_ERRORS.INVALID_REVIEW_RESULT, 'reviewResult must be an object with a proposal');
  }
  if (reviewResult.protocol !== EXPECTED_PROTOCOL) {
    return fail(PENDING_PROPOSAL_ERRORS.INVALID_PROTOCOL);
  }
  if (reviewResult.status !== 'ACCEPTED_FOR_REVIEW') {
    return fail(PENDING_PROPOSAL_ERRORS.PROPOSAL_NOT_ACCEPTED);
  }
  if (reviewResult.execution_performed !== false) {
    return fail(PENDING_PROPOSAL_ERRORS.EXECUTION_ALREADY_PERFORMED);
  }
  if (reviewResult.human_turn_required !== true) {
    return fail(PENDING_PROPOSAL_ERRORS.HUMAN_TURN_INVARIANT_VIOLATION);
  }

  const proposal = reviewResult.proposal;
  const authority = proposal.authority;
  if (!authority || authority.state !== 'PENDING_HUMAN_TURN' || authority.human_turn_required !== true) {
    return fail(PENDING_PROPOSAL_ERRORS.HUMAN_TURN_INVARIANT_VIOLATION);
  }

  const identity = extractIdentity(proposal);
  if (!identity) {
    return fail(PENDING_PROPOSAL_ERRORS.PROPOSAL_IDENTITY_INCOMPLETE);
  }
  const { packet, routePlan, requestedExecution, origin } = identity;

  // Defense-in-depth: the control plane (adapters/ourself-intake.js) already
  // enforces packet.route === route_plan.route before translation to a kernel
  // proposal. This module never assumes that path was taken — a hand-built
  // reviewResult could bypass intake entirely — so the same command-route
  // agreement is reproven here, before any record is constructed or written.
  // This is NOT the pipeline/queue route BridgeSELF derives later; it is the
  // fixed command-category the packet and its route plan must already agree on.
  if (packet.route !== routePlan.route) {
    return fail(PENDING_PROPOSAL_ERRORS.ROUTE_PLAN_PACKET_MISMATCH, 'packet and route plan disagree on command route');
  }

  const execClass = EXECUTION_CLASSES[proposal.executionClass];
  if (!proposal.executionClass || !EXECUTION_CLASS_NAMES.includes(proposal.executionClass) || !execClass || !execClass.terminal) {
    return fail(PENDING_PROPOSAL_ERRORS.UNKNOWN_EXECUTION_CLASS);
  }

  const computedChecksum = computeSemanticChecksum(packet, routePlan, requestedExecution);
  if (options.semanticChecksum && options.semanticChecksum !== computedChecksum) {
    return fail(PENDING_PROPOSAL_ERRORS.INVALID_SEMANTIC_CHECKSUM);
  }

  const proposalId = packet.packet_id;
  const resolved = resolveProposalPath(storageRoot, proposalId);
  if (!resolved.ok) {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTENCE_BOUNDARY_VIOLATION, 'proposal id is not a safe storage token');
  }
  if (!(await assertNotSymlink(resolved.target))) {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTENCE_BOUNDARY_VIOLATION, 'refusing to follow a symlinked proposal record');
  }

  const identityBindingHash = computeIdentityBindingHash({
    protocol: reviewResult.protocol,
    semanticChecksum: computedChecksum,
    packet,
    origin,
  });

  // Idempotency / conflict check against any existing record for this ID.
  const existingRaw = await readFile(resolved.target, 'utf8').catch(() => null);
  if (existingRaw !== null) {
    let existing;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      return fail(PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INVALID, 'existing record is malformed JSON');
    }
    const existingBinding = existing?.integrity?.identity_binding_hash;
    if (existingBinding === identityBindingHash && existing?.semantic_checksum === computedChecksum) {
      return {
        ok: true,
        idempotent: true,
        code: PENDING_PROPOSAL_ERRORS.PROPOSAL_ALREADY_PERSISTED,
        state: existing.state,
        proposal_id: proposalId,
        record: existing,
      };
    }
    return fail(PENDING_PROPOSAL_ERRORS.PROPOSAL_IDENTITY_CONFLICT, 'proposal id already persisted with different identity/content');
  }

  const admittedAt = options.admittedAt || new Date().toISOString();

  let globalEvent;
  try {
    globalEvent = await appendGlobalEvent(storageRoot, {
      event_version: EVENT_VERSION,
      type: 'PROPOSAL_PERSISTED',
      proposal_id: proposalId,
      at: admittedAt,
    });
  } catch (err) {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTENCE_WRITE_FAILED, String(err.message || err));
  }

  const record = {
    record_version: RECORD_VERSION,
    proposal_id: proposalId,
    state: 'PERSISTED_PENDING',
    protocol: reviewResult.protocol,
    semantic_checksum: computedChecksum,
    origin,
    packet,
    route_plan: routePlan,
    requested_execution: requestedExecution,
    expected_evidence: proposal.evidence || proposal.proof || [],
    admission: {
      status: 'ACCEPTED_FOR_REVIEW',
      admitted_at: admittedAt,
      kernel_head: options.kernelHead ?? null,
      control_plane_head: options.controlPlaneHead ?? null,
    },
    authority: {
      human_turn_required: true,
      decision_state: 'PENDING',
    },
    events: [
      {
        event_version: EVENT_VERSION,
        type: 'PROPOSAL_PERSISTED',
        proposal_id: proposalId,
        at: admittedAt,
        event_hash: globalEvent.event_hash,
        previous_event_hash: globalEvent.previous_event_hash,
      },
    ],
    integrity: {
      identity_binding_hash: identityBindingHash,
      previous_event_hash: globalEvent.previous_event_hash,
      record_hash: null,
    },
  };
  record.integrity.record_hash = computeRecordHash(record);

  try {
    await atomicWriteJson(resolved.target, record);
  } catch (err) {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTENCE_WRITE_FAILED, String(err.message || err));
  }

  return { ok: true, idempotent: false, state: 'PERSISTED_PENDING', proposal_id: proposalId, record };
}

/**
 * Retrieve one persisted proposal record by ID. Never follows a symlink.
 * @param {string} storageRoot
 * @param {string} proposalId
 * @returns {Promise<object>}
 */
export async function getPendingProposal(storageRoot, proposalId) {
  const resolved = resolveProposalPath(storageRoot, proposalId);
  if (!resolved.ok) {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTENCE_BOUNDARY_VIOLATION, 'proposal id is not a safe storage token');
  }
  if (!(await assertNotSymlink(resolved.target))) {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTENCE_BOUNDARY_VIOLATION, 'refusing to follow a symlinked proposal record');
  }
  const raw = await readFile(resolved.target, 'utf8').catch(() => null);
  if (raw === null) {
    return fail(PENDING_PROPOSAL_ERRORS.PROPOSAL_NOT_FOUND);
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return fail(PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INVALID, 'record is malformed JSON');
  }
  return { ok: true, record };
}

/**
 * List all persisted pending proposals. Malformed records are reported
 * separately in `corrupted` rather than aborting the whole listing —
 * one bad record must never hide the valid ones.
 * @param {string} storageRoot
 * @returns {Promise<{ ok: true, proposals: object[], corrupted: object[] }>}
 */
export async function listPendingProposals(storageRoot) {
  const dir = proposalsDir(storageRoot);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const proposals = [];
  const corrupted = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const proposalId = entry.name.slice(0, -'.json'.length);
    const result = await getPendingProposal(storageRoot, proposalId);
    if (result.ok) {
      proposals.push(result.record);
    } else {
      corrupted.push({ proposal_id: proposalId, error: result.error });
    }
  }
  proposals.sort((a, b) => (a.admission.admitted_at || '').localeCompare(b.admission.admitted_at || '') || a.proposal_id.localeCompare(b.proposal_id));
  return { ok: true, proposals, corrupted };
}

/**
 * Verify a persisted record's integrity: record hash, identity binding hash,
 * and recomputed semantic checksum must all match what is stored. Never
 * mutates authority or execution state, regardless of outcome.
 * @param {string} storageRoot
 * @param {string} proposalId
 * @returns {Promise<object>}
 */
export async function verifyPendingProposal(storageRoot, proposalId) {
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;
  const details = [];

  if (!record.integrity || typeof record.integrity.record_hash !== 'string') {
    details.push('missing_record_hash');
  } else {
    const recomputed = computeRecordHash(record);
    if (recomputed !== record.integrity.record_hash) details.push('record_hash_mismatch');
  }

  if (record.packet && record.route_plan && record.requested_execution) {
    const recomputedChecksum = computeSemanticChecksum(record.packet, record.route_plan, record.requested_execution);
    if (recomputedChecksum !== record.semantic_checksum) details.push('semantic_checksum_mismatch');
  } else {
    details.push('incomplete_identity_fields');
  }

  if (record.packet && record.origin) {
    const recomputedBinding = computeIdentityBindingHash({
      protocol: record.protocol,
      semanticChecksum: record.semantic_checksum,
      packet: record.packet,
      origin: record.origin,
    });
    if (!record.integrity || recomputedBinding !== record.integrity.identity_binding_hash) {
      details.push('identity_binding_hash_mismatch');
    }
  }

  if (details.length > 0) {
    return { ok: true, valid: false, error: PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INTEGRITY_FAILURE, details };
  }
  return { ok: true, valid: true };
}

/**
 * Replay the store-wide event ledger and verify its hash chain is unbroken —
 * detects reordering, truncation-with-splice, or tampered previous-hash
 * pointers across the whole store (not just a single record).
 * @param {string} storageRoot
 * @returns {Promise<object>}
 */
export async function verifyEventLedger(storageRoot) {
  const raw = await readFile(eventsLedgerPath(storageRoot), 'utf8').catch(() => '');
  const lines = raw.split('\n').filter(Boolean);
  let previousHash = null;
  for (let i = 0; i < lines.length; i++) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      return { ok: true, valid: false, error: PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INVALID, brokenAtLine: i };
    }
    const { event_hash, ...rest } = event;
    if (rest.previous_event_hash !== previousHash) {
      return { ok: true, valid: false, error: PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INTEGRITY_FAILURE, brokenAtLine: i, reason: 'previous_event_hash_mismatch' };
    }
    if (canonicalHash(rest) !== event_hash) {
      return { ok: true, valid: false, error: PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INTEGRITY_FAILURE, brokenAtLine: i, reason: 'event_hash_mismatch' };
    }
    previousHash = event_hash;
  }
  return { ok: true, valid: true, eventCount: lines.length };
}
