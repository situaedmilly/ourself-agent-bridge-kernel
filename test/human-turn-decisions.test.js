// test/human-turn-decisions.test.js
// ── T-031: HUMAN-TURN Decision Consumption — targeted proof suite ───────────
// Every test uses its own isolated temp storageRoot. Numbers in comments map
// to the T-031 REQUIRED TESTS list and, where noted, to the trusted-verifier
// CORRECTION's required test list (1-28). Full-suite/repository-scope checks
// (items 26-28 of the correction, 53-56 of the original gate) are proven at
// the session level via `npm test` from both repositories and `git status`,
// not as unit tests in this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, getPendingProposal, listPendingProposals, verifyPendingProposal, verifyEventLedger } from '../persistence/pending-proposals.js';
import {
  createStaticHumanTurnTokenVerifier,
  createHumanTurnDecisionService,
  getProposalAuthorityState,
  verifyProposalDecision,
  DECISION_VERSION,
  HUMAN_TURN_DECISION_ERRORS,
} from '../persistence/human-turn-decisions.js';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-human-turn-decisions-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function uniqueId(label = 'test') {
  return `packet-${label}-${randomBytes(4).toString('hex')}`;
}

function buildProposal({ packetId, executionClass = 'inspect', mutation = false, route = 'inspect' }) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route, sia: 'ClaudeCodeSELF',
    execution_class: executionClass, intent: 'inspect the repo status', target: null, status: 'planned',
    created: '2026-07-10T00:00:00.000Z', parent_aecho: null, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched inspect heuristic',
  };
  const routePlan = {
    route, sia: 'ClaudeCodeSELF', execution_class: executionClass, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched inspect heuristic', status: 'planned',
  };
  const requestedExecution = { class: executionClass, mutation_requested: mutation };
  const origin = { self: 'ourself-agent-bridge', source: 'local-handshake-runner' };
  return {
    id: packetId, source: 'ourself-intake', origin, kind: 'proposal', executionClass, mutation, route,
    reason: routePlan.reason, requiresApproval: true, proof: ['stdout'], evidence: [],
    data: { packet, routePlan, requestedExecution },
    authority: { state: 'PENDING_HUMAN_TURN', human_turn_required: true },
  };
}

function buildReviewResult(overrides = {}) {
  const packetId = overrides.packetId || uniqueId();
  const proposal = overrides.proposal !== undefined ? overrides.proposal : buildProposal({ packetId });
  return {
    protocol: 'ourself.ae-kernel.v1', status: 'ACCEPTED_FOR_REVIEW', execution_performed: false,
    human_turn_required: true, proposal,
  };
}

async function persistFresh(dir, overrides = {}) {
  const review = buildReviewResult(overrides);
  const result = await persistPendingProposal(dir, review);
  assert.equal(result.ok, true, 'fixture persist must succeed');
  return result;
}

// Decision payload — deliberately carries NO credential of any kind. The
// credential travels only as the service call's separate `presentedToken`.
function decisionFor(record, { decision, decisionId, reason = 'Authorize isolated proof only. Execution remains forbidden.', constraints = [], decidedAt = '2026-07-10T00:05:00.000Z' } = {}) {
  const latestEvent = record.events[record.events.length - 1];
  return {
    decision_version: DECISION_VERSION,
    decision_id: decisionId || uniqueId('decision'),
    proposal_id: record.proposal_id,
    decision,
    decided_by: 'MYSELF',
    decided_at: decidedAt,
    proposal_integrity: {
      record_hash: record.integrity.record_hash,
      semantic_checksum: record.semantic_checksum,
      latest_event_hash: latestEvent.event_hash,
    },
    reason,
    constraints,
  };
}

// Build a service scoped to exactly one proposal+decision+token — mirrors
// how trusted composition code would construct it, separately from any
// untrusted decision payload.
function serviceFor(proposalId, decision, token, authorityId = 'MYSELF') {
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision, authorityId, expectedToken: token });
  return createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
}

const AUTH_TOKEN_A = 'human-turn-test-token-A-do-not-reuse';
const AUTH_TOKEN_B = 'human-turn-test-token-B-do-not-reuse';

// ── Correction-required tests (1-25; 26-28 proven at session level) ─────────

test('1. decision input cannot contain an expected token', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const decision = { ...decisionFor(persisted.record, { decision: 'AUTHORIZE' }), expected_authorization_token: AUTH_TOKEN_A };
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: decision, presentedToken: AUTH_TOKEN_A });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_DECISION);
  });
});

test('2. decision input cannot select the verifier (no verifier field is ever read from decisionInput)', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const maliciousVerifier = () => ({ authorized: true, authorityId: 'MYSELF', verificationMethod: 'attacker_supplied' });
    const decision = { ...decisionFor(persisted.record, { decision: 'AUTHORIZE' }), verifyHumanTurnAuthorization: maliciousVerifier, verifier: maliciousVerifier };
    // The service was constructed with the LEGITIMATE verifier; nothing in
    // decisionInput can substitute a different one — there is no code path
    // that reads a verifier off the payload at all.
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: decision, presentedToken: 'totally-wrong-token' });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
  });
});

test('3. the recording call accepts only the presented token from untrusted input', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const decision = decisionFor(persisted.record, { decision: 'AUTHORIZE' });
    assert.equal('authorization_token' in decision, false);
    const result = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: decision, presentedToken: AUTH_TOKEN_A });
    assert.equal(result.ok, true);
  });
});

test('4. the expected token remains inside trusted verifier configuration (module never exports it)', async () => {
  const humanTurnModule = await import('../persistence/human-turn-decisions.js');
  assert.equal('expectedToken' in humanTurnModule, false);
  assert.equal(typeof humanTurnModule.createStaticHumanTurnTokenVerifier, 'function');
});

test('5. correct presented token authorizes the intended proposal and decision', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'AUTHORIZED_PENDING_EXECUTION');
  });
});

test('6. an incorrect token is rejected', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: 'not-the-right-token',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
  });
});

test('7. a caller cannot pass a matching fake "expected" token to force acceptance', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const forgedToken = 'ATTACKER_CHOSEN_TOKEN';
    // The attacker controls both values in their own head, but the service
    // call shape has no field for "expectedToken" at all — it is architecturally
    // impossible to supply one, and even attaching an extra ignored field
    // (simulating a naive client bug) must not influence the trusted verifier.
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: forgedToken,
      expectedToken: forgedToken, // extraneous field — must be silently ignored, never trusted
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
  });
});

test('8. token for proposal A fails against proposal B', async () => {
  await withTempStore(async (dir) => {
    const a = await persistFresh(dir);
    const b = await persistFresh(dir);
    const serviceForA = serviceFor(a.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await serviceForA.recordHumanTurnDecision({
      storageRoot: dir, proposalId: b.proposal_id,
      decisionInput: decisionFor(b.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.ok, false);
  });
});

test('9. an AUTHORIZE-scoped token fails when presented for REJECT', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const authorizeService = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await authorizeService.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'REJECT' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
  });
});

test('10. a REJECT-scoped token fails when presented for AUTHORIZE', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const rejectService = serviceFor(persisted.proposal_id, 'REJECT', AUTH_TOKEN_A);
    const result = await rejectService.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
  });
});

test('11. decided_by other than MYSELF is rejected before verification, and a verifier answering for a different authority is rejected too', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const decision = { ...decisionFor(persisted.record, { decision: 'AUTHORIZE' }), decided_by: 'CLAUDESELF' };
    const result = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: decision, presentedToken: AUTH_TOKEN_A });
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_DECIDING_AUTHORITY);

    // Verifier scoped to a DIFFERENT authorityId than the decision claims.
    const mismatchedVerifier = createStaticHumanTurnTokenVerifier({ proposalId: persisted.proposal_id, decision: 'AUTHORIZE', authorityId: 'SOMEONE_ELSE', expectedToken: AUTH_TOKEN_A });
    const mismatchedService = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: mismatchedVerifier });
    const result2 = await mismatchedService.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result2.ok, false);
  });
});

test('12. a failed verifier result appends no event', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: 'wrong',
    });
    const ledger = await verifyEventLedger(dir);
    assert.equal(ledger.eventCount, 1); // only the original PROPOSAL_PERSISTED
  });
});

test('13. a verifier exception fails closed and appends no event', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const throwingVerifier = () => { throw new Error('simulated verifier failure'); };
    const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: throwingVerifier });
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
    const ledger = await verifyEventLedger(dir);
    assert.equal(ledger.eventCount, 1);
  });
});

test('14. a missing verifier fails closed', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = createHumanTurnDecisionService({});
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.INVALID_AUTHORIZATION_TOKEN);
  });
});

test('15. a malformed verifier response fails closed', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    for (const malformed of [null, undefined, 'authorized', { authorized: 'true' }, { authorized: true }, { authorized: true, authorityId: '' }, 42]) {
      const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: () => malformed });
      const result = await service.recordHumanTurnDecision({
        storageRoot: dir, proposalId: persisted.proposal_id,
        decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
        presentedToken: AUTH_TOKEN_A,
      });
      assert.equal(result.ok, false, `expected rejection for malformed verdict: ${JSON.stringify(malformed)}`);
    }
  });
});

test('16. raw presented token is not persisted', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    const raw = JSON.stringify(result.record);
    assert.equal(raw.includes(AUTH_TOKEN_A), false);
  });
});

test('17. raw expected token is not persisted and never leaves the verifier closure', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_B);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_B,
    });
    const raw = JSON.stringify(result.record);
    assert.equal(raw.includes(AUTH_TOKEN_B), false);
    const onDisk = await readFile(join(dir, 'proposals', `${persisted.proposal_id}.json`), 'utf8');
    assert.equal(onDisk.includes(AUTH_TOKEN_B), false);
  });
});

test('18. the persisted verification receipt is bounded and contains no credential', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    const receipt = result.record.authority.verification;
    assert.equal(receipt.authority_id, 'MYSELF');
    assert.equal(receipt.verification_method, 'static_token_verifier');
    assert.match(receipt.credential_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(Object.keys(receipt).length, 3);
  });
});

test('19. an identical valid decision remains idempotent under the corrected model', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const decision = decisionFor(persisted.record, { decision: 'AUTHORIZE', decisionId: 'fixed-decision-idem' });
    const first = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: decision, presentedToken: AUTH_TOKEN_A });
    const second = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: decision, presentedToken: AUTH_TOKEN_A });
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    const ledger = await verifyEventLedger(dir);
    assert.equal(ledger.eventCount, 2); // PERSISTED + AUTHORIZED, no duplicate
  });
});

test('20. a conflicting decision remains rejected under the corrected model', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const authorizeService = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    await authorizeService.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE', decisionId: 'decision-x' }),
      presentedToken: AUTH_TOKEN_A,
    });
    const current = await getPendingProposal(dir, persisted.proposal_id);
    const rejectService = serviceFor(persisted.proposal_id, 'REJECT', AUTH_TOKEN_B);
    const result = await rejectService.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(current.record, { decision: 'REJECT', decisionId: 'decision-y' }),
      presentedToken: AUTH_TOKEN_B,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.DECISION_CONFLICT);
  });
});

test('21. authorization still produces AUTHORIZED_PENDING_EXECUTION', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.state, 'AUTHORIZED_PENDING_EXECUTION');
    assert.equal(result.decision_state, 'AUTHORIZED');
  });
});

test('22. rejection still produces REJECTED_FINAL', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'REJECT', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'REJECT' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(result.state, 'REJECTED_FINAL');
    assert.equal(result.decision_state, 'REJECTED');
  });
});

test('23. no execution event is produced — only PROPOSAL_AUTHORIZED / PROPOSAL_REJECTED ever appear', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    for (const e of result.record.events) {
      assert.ok(['PROPOSAL_PERSISTED', 'PROPOSAL_AUTHORIZED', 'PROPOSAL_REJECTED'].includes(e.type));
    }
  });
});

test('24. no execution primitive is imported by the module', async () => {
  const src = await readFile(new URL('../persistence/human-turn-decisions.js', import.meta.url), 'utf8');
  assert.equal(/tools\/terminal/.test(src), false);
  assert.equal(/child_process|execSync|spawn\(/.test(src), false);
  assert.equal(/\bfetch\(|node:http|node:https/.test(src), false);
});

test('25. T-030 persistence tests remain green (spot check: pending reads/integrity unaffected)', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const got = await getPendingProposal(dir, persisted.proposal_id);
    assert.equal(got.record.state, 'PERSISTED_PENDING');
    const check = await verifyPendingProposal(dir, persisted.proposal_id);
    assert.equal(check.valid, true);
  });
});

// ── Remaining T-031 behavior (state model, integrity, boundary, recovery) ───

test('original proposal content is unchanged by authorization', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const result = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    assert.deepEqual(result.record.packet, persisted.record.packet);
    assert.deepEqual(result.record.route_plan, persisted.record.route_plan);
  });
});

test('authorization and rejection survive a fresh read', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    const fresh = await getProposalAuthorityState(dir, persisted.proposal_id);
    assert.equal(fresh.state, 'AUTHORIZED_PENDING_EXECUTION');
  });
});

test('missing proposal is rejected', async () => {
  await withTempStore(async (dir) => {
    const service = serviceFor('does-not-exist', 'AUTHORIZE', AUTH_TOKEN_A);
    const decision = {
      decision_version: DECISION_VERSION, decision_id: 'x', proposal_id: 'does-not-exist', decision: 'AUTHORIZE',
      decided_by: 'MYSELF', decided_at: '2026-07-10T00:05:00.000Z',
      proposal_integrity: { record_hash: 'a'.repeat(64), semantic_checksum: 'b'.repeat(64), latest_event_hash: 'c'.repeat(64) },
      reason: 'n/a', constraints: [],
    };
    const result = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: 'does-not-exist', decisionInput: decision, presentedToken: AUTH_TOKEN_A });
    assert.equal(result.ok, false);
    assert.equal(result.error, HUMAN_TURN_DECISION_ERRORS.PROPOSAL_NOT_FOUND);
  });
});

test('stale record-hash and event-head fingerprints are rejected on a first decision', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    const badHash = { ...decisionFor(persisted.record, { decision: 'AUTHORIZE' }) };
    badHash.proposal_integrity.record_hash = 'deadbeef'.repeat(8);
    const r1 = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: badHash, presentedToken: AUTH_TOKEN_A });
    assert.equal(r1.error, HUMAN_TURN_DECISION_ERRORS.DECISION_RECORD_HASH_MISMATCH);

    const badEvent = { ...decisionFor(persisted.record, { decision: 'AUTHORIZE' }) };
    badEvent.proposal_integrity.latest_event_hash = 'deadbeef'.repeat(8);
    const r2 = await service.recordHumanTurnDecision({ storageRoot: dir, proposalId: persisted.proposal_id, decisionInput: badEvent, presentedToken: AUTH_TOKEN_A });
    assert.equal(r2.error, HUMAN_TURN_DECISION_ERRORS.DECISION_EVENT_HEAD_MISMATCH);
  });
});

test('listing deterministically distinguishes pending, authorized, and rejected states', async () => {
  await withTempStore(async (dir) => {
    const pendingProp = await persistFresh(dir);
    const authorizedProp = await persistFresh(dir);
    const rejectedProp = await persistFresh(dir);
    await serviceFor(authorizedProp.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A).recordHumanTurnDecision({
      storageRoot: dir, proposalId: authorizedProp.proposal_id, decisionInput: decisionFor(authorizedProp.record, { decision: 'AUTHORIZE' }), presentedToken: AUTH_TOKEN_A,
    });
    await serviceFor(rejectedProp.proposal_id, 'REJECT', AUTH_TOKEN_A).recordHumanTurnDecision({
      storageRoot: dir, proposalId: rejectedProp.proposal_id, decisionInput: decisionFor(rejectedProp.record, { decision: 'REJECT' }), presentedToken: AUTH_TOKEN_A,
    });
    const listing = await listPendingProposals(dir);
    const byId = Object.fromEntries(listing.proposals.map((p) => [p.proposal_id, p.state]));
    assert.equal(byId[pendingProp.proposal_id], 'PERSISTED_PENDING');
    assert.equal(byId[authorizedProp.proposal_id], 'AUTHORIZED_PENDING_EXECUTION');
    assert.equal(byId[rejectedProp.proposal_id], 'REJECTED_FINAL');
  });
});

test('decision-payload tampering on disk is detected', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A);
    await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }),
      presentedToken: AUTH_TOKEN_A,
    });
    const path = join(dir, 'proposals', `${persisted.proposal_id}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.authority.reason = 'tampered, never decided';
    await writeFile(path, JSON.stringify(record, null, 2));
    const check = await verifyPendingProposal(dir, persisted.proposal_id);
    assert.equal(check.valid, false);
  });
});

test('decision integrity verifies before tampering', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistFresh(dir);
    const service = serviceFor(persisted.proposal_id, 'REJECT', AUTH_TOKEN_A);
    await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: persisted.proposal_id,
      decisionInput: decisionFor(persisted.record, { decision: 'REJECT' }),
      presentedToken: AUTH_TOKEN_A,
    });
    const check = await verifyProposalDecision(dir, persisted.proposal_id);
    assert.equal(check.valid, true);
  });
});

test('one corrupted proposal does not silently authorize or block any other proposal', async () => {
  await withTempStore(async (dir) => {
    const corrupted = await persistFresh(dir);
    const healthy = await persistFresh(dir);
    await writeFile(join(dir, 'proposals', `${corrupted.proposal_id}.json`), 'not json');

    const corruptedAttempt = await serviceFor(corrupted.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A).recordHumanTurnDecision({
      storageRoot: dir, proposalId: corrupted.proposal_id, decisionInput: decisionFor(corrupted.record, { decision: 'AUTHORIZE' }), presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(corruptedAttempt.ok, false);

    const healthyAttempt = await serviceFor(healthy.proposal_id, 'AUTHORIZE', AUTH_TOKEN_A).recordHumanTurnDecision({
      storageRoot: dir, proposalId: healthy.proposal_id, decisionInput: decisionFor(healthy.record, { decision: 'AUTHORIZE' }), presentedToken: AUTH_TOKEN_A,
    });
    assert.equal(healthyAttempt.ok, true);
  });
});
