// persistence/human-turn-decisions.js
// ── T-031: HUMAN-TURN Decision Consumption for Persisted OURSELF Proposals ──
//
// PURPOSE
//   Convert a durable PERSISTED_PENDING proposal (T-030) into either
//   AUTHORIZED_PENDING_EXECUTION or REJECTED_FINAL through an explicit,
//   integrity-bound HUMAN-TURN decision — WITHOUT invoking execution.
//
// TRUST BOUNDARY (corrected)
//   The decision operation accepts authority only through a separately
//   supplied trusted verifier. Untrusted decision input cannot choose the
//   expected credential or override the verifier result. The expected
//   credential is captured in a verifier's closure at trusted construction
//   time (createStaticHumanTurnTokenVerifier) — it never travels through
//   decisionInput, through options, or through any other field of a single
//   untrusted call. A caller that controls the decision payload and the
//   presented token still cannot choose what the verifier expects.
//
//   The local static-token verifier proves credential agreement within the
//   tested composition boundary; it does not independently prove the
//   physical identity of the person presenting the credential.
//
// FOUNDATIONAL DISTINCTION (enforced by this module)
//   DECISION RECORDED              ≠  EXECUTION STARTED
//   AUTHORIZED_PENDING_EXECUTION   ≠  EXECUTABLE WITHOUT T-032
//   REJECTED_FINAL                 ≠  DELETED
//   HUMAN-TURN AUTHORITY           ≠  CLAUDESELF AUTHORITY
//   COMPARISON CORRECTNESS         ≠  AUTHORITY CORRECTNESS
//
// HARD INVARIANTS (this module NEVER)
//   • executes a proposal;
//   • imports a terminal/execution primitive;
//   • invokes a child process or network call;
//   • mutates a target project;
//   • fabricates, infers, or self-issues a decision;
//   • accepts a decision from an untrusted field inside the original Æ packet;
//   • allows AUTHORIZED_PENDING_EXECUTION or REJECTED_FINAL to transition
//     back to PENDING or to each other (terminal states are terminal);
//   • lets decisionInput carry the expected credential or select the verifier;
//   • persists a raw token value (only a SHA-256 credential fingerprint).
//
// STORAGE
//   Reuses the SAME per-proposal record file and the SAME store-wide
//   events.jsonl ledger that persistence/pending-proposals.js (T-030) owns —
//   no second storage root, no second authority model.
//
// REQUIRED REJECTION / RESULT CODES
//   PROPOSAL_NOT_FOUND · PROPOSAL_NOT_PENDING · PROPOSAL_INTEGRITY_FAILURE ·
//   EVENT_LEDGER_INTEGRITY_FAILURE · INVALID_DECISION_VERSION · INVALID_DECISION ·
//   INVALID_DECISION_ID · INVALID_AUTHORIZATION_TOKEN · INVALID_DECIDING_AUTHORITY ·
//   DECISION_PROPOSAL_MISMATCH · DECISION_RECORD_HASH_MISMATCH ·
//   DECISION_SEMANTIC_CHECKSUM_MISMATCH · DECISION_EVENT_HEAD_MISMATCH ·
//   DECISION_ALREADY_RECORDED · DECISION_IDENTITY_CONFLICT · DECISION_CONFLICT ·
//   DECISION_WRITE_FAILED · DECISION_RECORD_INVALID · DECISION_INTEGRITY_FAILURE ·
//   EXECUTION_FORBIDDEN_IN_T031

'use strict';

import { timingSafeEqual, createHash } from 'node:crypto';
import {
  getPendingProposal,
  verifyPendingProposal,
  verifyEventLedger,
  resolveProposalPath,
  assertNotSymlink,
  appendGlobalEvent,
  atomicWriteJson,
  computeRecordHash,
  EVENT_VERSION,
} from './pending-proposals.js';

export const DECISION_VERSION = 'ourself.human-turn-decision.v1';
const REQUIRED_DECIDING_AUTHORITY = 'MYSELF';
const VALID_DECISIONS = Object.freeze({ AUTHORIZE: 'PROPOSAL_AUTHORIZED', REJECT: 'PROPOSAL_REJECTED' });
const MAX_REASON_LENGTH = 500;
const MAX_CONSTRAINTS = 10;
const MAX_CONSTRAINT_LENGTH = 200;
const SAFE_DECISION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CONSTRAINT_TEXT = /^[\x20-\x7E]{1,200}$/;
// Fields that would smuggle an execution directive through the decision
// contract itself. None of these are ever read for anything but this guard —
// this module has no code path that could act on them even if present.
const FORBIDDEN_EXECUTION_FIELDS = ['execute', 'executeNow', 'runExecution', 'invokeExecution', 'dispatch'];
// The expected credential (or anything token-shaped) must never enter through
// the untrusted decision payload — only through the trusted verifier closure.
const FORBIDDEN_TOKEN_FIELDS = ['authorization_token', 'expected_authorization_token', 'expectedToken', 'presentedToken', 'token', 'expected_token'];

export const HUMAN_TURN_DECISION_ERRORS = Object.freeze({
  PROPOSAL_NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  PROPOSAL_NOT_PENDING: 'PROPOSAL_NOT_PENDING',
  PROPOSAL_INTEGRITY_FAILURE: 'PROPOSAL_INTEGRITY_FAILURE',
  EVENT_LEDGER_INTEGRITY_FAILURE: 'EVENT_LEDGER_INTEGRITY_FAILURE',
  INVALID_DECISION_VERSION: 'INVALID_DECISION_VERSION',
  INVALID_DECISION: 'INVALID_DECISION',
  INVALID_DECISION_ID: 'INVALID_DECISION_ID',
  INVALID_AUTHORIZATION_TOKEN: 'INVALID_AUTHORIZATION_TOKEN',
  INVALID_DECIDING_AUTHORITY: 'INVALID_DECIDING_AUTHORITY',
  DECISION_PROPOSAL_MISMATCH: 'DECISION_PROPOSAL_MISMATCH',
  DECISION_RECORD_HASH_MISMATCH: 'DECISION_RECORD_HASH_MISMATCH',
  DECISION_SEMANTIC_CHECKSUM_MISMATCH: 'DECISION_SEMANTIC_CHECKSUM_MISMATCH',
  DECISION_EVENT_HEAD_MISMATCH: 'DECISION_EVENT_HEAD_MISMATCH',
  DECISION_ALREADY_RECORDED: 'DECISION_ALREADY_RECORDED',
  DECISION_IDENTITY_CONFLICT: 'DECISION_IDENTITY_CONFLICT',
  DECISION_CONFLICT: 'DECISION_CONFLICT',
  DECISION_WRITE_FAILED: 'DECISION_WRITE_FAILED',
  DECISION_RECORD_INVALID: 'DECISION_RECORD_INVALID',
  DECISION_INTEGRITY_FAILURE: 'DECISION_INTEGRITY_FAILURE',
  EXECUTION_FORBIDDEN_IN_T031: 'EXECUTION_FORBIDDEN_IN_T031',
});
const KNOWN_ERROR_CODES = new Set(Object.values(HUMAN_TURN_DECISION_ERRORS));

const TERMINAL_STATE_BY_DECISION = Object.freeze({
  AUTHORIZE: 'AUTHORIZED_PENDING_EXECUTION',
  REJECT: 'REJECTED_FINAL',
});
const DECISION_STATE_BY_DECISION = Object.freeze({ AUTHORIZE: 'AUTHORIZED', REJECT: 'REJECTED' });

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time token comparison — mirrors server.js requireToken's pattern. */
function tokensMatch(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateDecisionShape(decisionInput) {
  if (!decisionInput || typeof decisionInput !== 'object') {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, 'decision must be an object');
  }
  for (const field of FORBIDDEN_EXECUTION_FIELDS) {
    if (decisionInput[field]) {
      return fail(HUMAN_TURN_DECISION_ERRORS.EXECUTION_FORBIDDEN_IN_T031, `field "${field}" is forbidden in a T-031 decision contract`);
    }
  }
  for (const field of FORBIDDEN_TOKEN_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(decisionInput, field)) {
      return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, `decision input may not carry a credential field ("${field}") — credentials are supplied only through the trusted verifier boundary`);
    }
  }
  if (decisionInput.decision_version !== DECISION_VERSION) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION_VERSION);
  }
  if (!Object.prototype.hasOwnProperty.call(VALID_DECISIONS, decisionInput.decision)) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, 'decision must be AUTHORIZE or REJECT');
  }
  if (decisionInput.decided_by !== REQUIRED_DECIDING_AUTHORITY) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECIDING_AUTHORITY);
  }
  if (typeof decisionInput.decision_id !== 'string' || !SAFE_DECISION_ID.test(decisionInput.decision_id)) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION_ID);
  }
  if (typeof decisionInput.proposal_id !== 'string' || decisionInput.proposal_id.length === 0) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, 'proposal_id is required');
  }
  if (typeof decisionInput.decided_at !== 'string' || decisionInput.decided_at.length === 0) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, 'decided_at is required');
  }
  if (typeof decisionInput.reason !== 'string' || decisionInput.reason.length === 0 || decisionInput.reason.length > MAX_REASON_LENGTH) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, `reason must be a non-empty string of at most ${MAX_REASON_LENGTH} characters`);
  }
  const constraints = decisionInput.constraints ?? [];
  if (!Array.isArray(constraints) || constraints.length > MAX_CONSTRAINTS) {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, `constraints must be an array of at most ${MAX_CONSTRAINTS} entries`);
  }
  for (const c of constraints) {
    if (typeof c !== 'string' || !SAFE_CONSTRAINT_TEXT.test(c) || c.length > MAX_CONSTRAINT_LENGTH) {
      return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, 'each constraint must be a bounded, printable string');
    }
  }
  const pi = decisionInput.proposal_integrity;
  if (!pi || typeof pi !== 'object' || typeof pi.record_hash !== 'string' || typeof pi.semantic_checksum !== 'string' || typeof pi.latest_event_hash !== 'string') {
    return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION, 'proposal_integrity.{record_hash, semantic_checksum, latest_event_hash} are required');
  }
  return { ok: true };
}

function decisionContentEquals(a, b) {
  return (
    a.decision === b.decision &&
    a.reason === b.reason &&
    JSON.stringify(a.constraints || []) === JSON.stringify(b.constraints || [])
  );
}

/**
 * Build a trusted HUMAN-TURN token verifier. The expected credential is
 * captured in this closure at CONSTRUCTION time by trusted composition code
 * (or by an isolated test) — it is never visible to, nor overridable by, the
 * untrusted decision-recording call. The returned function only ever sees
 * the presented token and the bounded decision context; it never returns the
 * expected token to its caller.
 *
 * @param {object} config
 * @param {string} config.proposalId - the proposal this verifier is scoped to.
 * @param {'AUTHORIZE'|'REJECT'} config.decision - the decision this verifier is scoped to.
 * @param {string} [config.authorityId='MYSELF'] - the authority this verifier represents.
 * @param {string} config.expectedToken - the trusted credential, captured by closure only.
 * @returns {function({proposalId, decision, decisionId, decidedBy, presentedToken}): {authorized: boolean, authorityId?: string, verificationMethod?: string, errorCode?: string}}
 */
export function createStaticHumanTurnTokenVerifier({ proposalId, decision, authorityId = REQUIRED_DECIDING_AUTHORITY, expectedToken }) {
  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    throw new TypeError('createStaticHumanTurnTokenVerifier requires proposalId');
  }
  if (!Object.prototype.hasOwnProperty.call(VALID_DECISIONS, decision)) {
    throw new TypeError('createStaticHumanTurnTokenVerifier requires a valid decision (AUTHORIZE|REJECT)');
  }
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    throw new TypeError('createStaticHumanTurnTokenVerifier requires a non-empty expectedToken');
  }
  return function verifyHumanTurnAuthorization(context) {
    const ctx = context || {};
    if (ctx.decidedBy !== authorityId) {
      return { authorized: false, errorCode: HUMAN_TURN_DECISION_ERRORS.INVALID_DECIDING_AUTHORITY };
    }
    if (ctx.proposalId !== proposalId || ctx.decision !== decision) {
      // Scoped verifier: a token configured for one proposal/decision must
      // fail for any other — this is what makes cross-proposal and
      // cross-decision replay fail even with the "correct" token string.
      return { authorized: false, errorCode: HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN };
    }
    if (!tokensMatch(ctx.presentedToken, expectedToken)) {
      return { authorized: false, errorCode: HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN };
    }
    return { authorized: true, authorityId, verificationMethod: 'static_token_verifier' };
  };
}

/**
 * Internal: consume a decision once a trusted `authorized: true` verdict has
 * already been obtained. Never called with an unverified request — see
 * createHumanTurnDecisionService, the only exported entry point that reaches here.
 */
async function applyDecision({ storageRoot, proposalId, decisionInput, verdict, presentedToken }) {
  const recordIntegrity = await verifyPendingProposal(storageRoot, proposalId);
  if (!recordIntegrity.ok) return recordIntegrity;
  if (recordIntegrity.valid === false) {
    return fail(HUMAN_TURN_DECISION_ERRORS.PROPOSAL_INTEGRITY_FAILURE, JSON.stringify(recordIntegrity.details));
  }

  const ledgerIntegrity = await verifyEventLedger(storageRoot);
  if (ledgerIntegrity.valid === false) {
    return fail(HUMAN_TURN_DECISION_ERRORS.EVENT_LEDGER_INTEGRITY_FAILURE, JSON.stringify(ledgerIntegrity));
  }

  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;

  const isFirstDecision = record.state === 'PERSISTED_PENDING' && record.authority.decision_state === 'PENDING';
  const isTerminal = record.state === 'AUTHORIZED_PENDING_EXECUTION' || record.state === 'REJECTED_FINAL';

  // Idempotency/conflict is checked BEFORE freshness of the caller's integrity
  // fingerprint: a legitimate repeat of an already-applied decision necessarily
  // carries the PRE-decision record_hash/latest_event_hash (that is what the
  // decision was validly prepared against), so it must not be misclassified
  // as a stale/tampered decision — it must be recognized as a repeat first.
  if (!isFirstDecision) {
    if (!isTerminal) {
      return fail(HUMAN_TURN_DECISION_ERRORS.PROPOSAL_NOT_PENDING, `unexpected proposal state: ${record.state}`);
    }
    const priorDecisionId = record.authority.decision_id;
    if (priorDecisionId === decisionInput.decision_id) {
      const priorContent = { decision: record.authority.decision, reason: record.authority.reason, constraints: record.authority.constraints };
      const newContent = { decision: decisionInput.decision, reason: decisionInput.reason, constraints: decisionInput.constraints ?? [] };
      if (decisionContentEquals(priorContent, newContent)) {
        return {
          ok: true,
          idempotent: true,
          code: HUMAN_TURN_DECISION_ERRORS.DECISION_ALREADY_RECORDED,
          state: record.state,
          decision_state: record.authority.decision_state,
          proposal_id: proposalId,
          record,
        };
      }
      return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_IDENTITY_CONFLICT, 'decision id already recorded with different content');
    }
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_CONFLICT, `proposal already reached a terminal authority state: ${record.state}`);
  }

  // Only a genuine first decision against a still-PENDING proposal is held to
  // freshness: the caller's captured fingerprint must match current state.
  const pi = decisionInput.proposal_integrity;
  if (pi.record_hash !== record.integrity.record_hash) {
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_RECORD_HASH_MISMATCH);
  }
  if (pi.semantic_checksum !== record.semantic_checksum) {
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_SEMANTIC_CHECKSUM_MISMATCH);
  }
  const latestEvent = record.events[record.events.length - 1];
  if (!latestEvent || pi.latest_event_hash !== latestEvent.event_hash) {
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_EVENT_HEAD_MISMATCH);
  }

  const eventType = VALID_DECISIONS[decisionInput.decision];

  let globalEvent;
  try {
    globalEvent = await appendGlobalEvent(storageRoot, {
      event_version: EVENT_VERSION,
      type: eventType,
      proposal_id: proposalId,
      at: decisionInput.decided_at,
    });
  } catch (err) {
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_WRITE_FAILED, String(err.message || err));
  }

  // Bounded verification receipt only — never the raw presented or expected
  // token. Proves credential agreement occurred through the named verifier;
  // does not itself prove physical human identity.
  const verificationReceipt = {
    authority_id: verdict.authorityId,
    verification_method: verdict.verificationMethod || 'injected_verifier',
    credential_fingerprint: `sha256:${sha256Hex(presentedToken)}`,
  };

  const updatedRecord = {
    ...record,
    state: TERMINAL_STATE_BY_DECISION[decisionInput.decision],
    authority: {
      ...record.authority,
      decision_state: DECISION_STATE_BY_DECISION[decisionInput.decision],
      decision_id: decisionInput.decision_id,
      decision: decisionInput.decision,
      decided_by: decisionInput.decided_by,
      decided_at: decisionInput.decided_at,
      reason: decisionInput.reason,
      constraints: decisionInput.constraints ?? [],
      verification: verificationReceipt,
    },
    events: [
      ...record.events,
      {
        event_version: EVENT_VERSION,
        type: eventType,
        proposal_id: proposalId,
        at: decisionInput.decided_at,
        event_hash: globalEvent.event_hash,
        previous_event_hash: globalEvent.previous_event_hash,
      },
    ],
  };
  updatedRecord.integrity = { ...record.integrity, record_hash: null };
  updatedRecord.integrity.record_hash = computeRecordHash(updatedRecord);

  const resolved = resolveProposalPath(storageRoot, proposalId);
  if (!resolved.ok || !(await assertNotSymlink(resolved.target))) {
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_WRITE_FAILED, 'proposal record path is no longer safe to write');
  }
  try {
    await atomicWriteJson(resolved.target, updatedRecord);
  } catch (err) {
    return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_WRITE_FAILED, String(err.message || err));
  }

  return {
    ok: true,
    idempotent: false,
    state: updatedRecord.state,
    decision_state: updatedRecord.authority.decision_state,
    proposal_id: proposalId,
    record: updatedRecord,
  };
}

/**
 * Construct the T-031 decision service, bound to exactly one trusted
 * authority verifier. The decision-recording call it exposes accepts ONLY
 * the presented token from untrusted input; the expected credential lives
 * solely inside the verifier this service was constructed with.
 *
 * @param {object} deps
 * @param {function({proposalId, decision, decisionId, decidedBy, presentedToken}): (object|Promise<object>)} deps.verifyHumanTurnAuthorization
 *   A trusted verifier — e.g. from createStaticHumanTurnTokenVerifier, or any
 *   equivalent trusted dependency supplied by composition code or a test.
 * @returns {object} service with recordHumanTurnDecision, getProposalAuthorityState, verifyProposalDecision
 */
export function createHumanTurnDecisionService({ verifyHumanTurnAuthorization }) {
  return {
    /**
     * @param {object} request
     * @param {string} request.storageRoot
     * @param {string} request.proposalId
     * @param {object} request.decisionInput - MUST NOT contain any credential field.
     * @param {string} request.presentedToken - the untrusted credential presented for this call.
     * @returns {Promise<object>}
     */
    async recordHumanTurnDecision({ storageRoot, proposalId, decisionInput, presentedToken }) {
      const shapeCheck = validateDecisionShape(decisionInput);
      if (!shapeCheck.ok) return shapeCheck;

      if (decisionInput.proposal_id !== proposalId) {
        return fail(HUMAN_TURN_DECISION_ERRORS.DECISION_PROPOSAL_MISMATCH);
      }

      if (typeof verifyHumanTurnAuthorization !== 'function') {
        return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN, 'no trusted verifier was supplied to this service');
      }

      let verdict;
      try {
        verdict = await verifyHumanTurnAuthorization({
          proposalId,
          decision: decisionInput.decision,
          decisionId: decisionInput.decision_id,
          decidedBy: decisionInput.decided_by,
          presentedToken,
        });
      } catch (err) {
        return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN, `verifier threw: ${String(err && err.message || err)}`);
      }

      if (!verdict || typeof verdict !== 'object' || verdict.authorized !== true || typeof verdict.authorityId !== 'string' || verdict.authorityId.length === 0) {
        const code = verdict && typeof verdict === 'object' && KNOWN_ERROR_CODES.has(verdict.errorCode) ? verdict.errorCode : HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN;
        return fail(code);
      }
      if (verdict.authorityId !== decisionInput.decided_by) {
        // The verifier answered for a different authority than the one this
        // decision claims — never let a mismatched verdict pass as a match.
        return fail(HUMAN_TURN_DECISION_ERRORS.INVALID_DECIDING_AUTHORITY);
      }

      return applyDecision({ storageRoot, proposalId, decisionInput, verdict, presentedToken });
    },

    getProposalAuthorityState: (storageRoot, proposalId) => getProposalAuthorityState(storageRoot, proposalId),
    verifyProposalDecision: (storageRoot, proposalId) => verifyProposalDecision(storageRoot, proposalId),
  };
}

/**
 * Read-only: derive the current authority state of a persisted proposal.
 * Involves no credential — safe to call directly without a service.
 * @param {string} storageRoot
 * @param {string} proposalId
 * @returns {Promise<object>}
 */
export async function getProposalAuthorityState(storageRoot, proposalId) {
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  return {
    ok: true,
    proposal_id: proposalId,
    state: got.record.state,
    decision_state: got.record.authority.decision_state,
    record: got.record,
  };
}

/**
 * Verify a persisted proposal's decision-relevant integrity: the underlying
 * T-030 record/ledger integrity, plus (if a decision has been recorded) that
 * the decision event's hash and the authority block are mutually consistent.
 * Never mutates authority or execution state regardless of outcome. Involves
 * no credential — safe to call directly without a service.
 * @param {string} storageRoot
 * @param {string} proposalId
 * @returns {Promise<object>}
 */
export async function verifyProposalDecision(storageRoot, proposalId) {
  const recordIntegrity = await verifyPendingProposal(storageRoot, proposalId);
  if (!recordIntegrity.ok) return recordIntegrity;
  if (recordIntegrity.valid === false) {
    return { ok: true, valid: false, error: HUMAN_TURN_DECISION_ERRORS.PROPOSAL_INTEGRITY_FAILURE, details: recordIntegrity.details };
  }

  const ledgerIntegrity = await verifyEventLedger(storageRoot);
  if (ledgerIntegrity.valid === false) {
    return { ok: true, valid: false, error: HUMAN_TURN_DECISION_ERRORS.EVENT_LEDGER_INTEGRITY_FAILURE, details: ledgerIntegrity };
  }

  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;

  if (record.authority.decision_state === 'PENDING') {
    return { ok: true, valid: true };
  }

  const latestEvent = record.events[record.events.length - 1];
  const expectedType = record.authority.decision_state === 'AUTHORIZED' ? 'PROPOSAL_AUTHORIZED' : 'PROPOSAL_REJECTED';
  if (!latestEvent || latestEvent.type !== expectedType) {
    return { ok: true, valid: false, error: HUMAN_TURN_DECISION_ERRORS.DECISION_INTEGRITY_FAILURE, details: ['latest_event_type_mismatch'] };
  }
  const expectedState = record.authority.decision_state === 'AUTHORIZED' ? 'AUTHORIZED_PENDING_EXECUTION' : 'REJECTED_FINAL';
  if (record.state !== expectedState) {
    return { ok: true, valid: false, error: HUMAN_TURN_DECISION_ERRORS.DECISION_INTEGRITY_FAILURE, details: ['state_decision_state_mismatch'] };
  }

  return { ok: true, valid: true };
}
