// test/pending-proposals.test.js
// ── T-030: Pending Proposal Persistence — targeted proof suite ──────────────
// Every test uses its own isolated temp storageRoot (node:os tmpdir). No test
// ever touches the live repository state, the control-plane repository, or
// any target project. Numbers in comments map to the T-030 REQUIRED TESTS list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  persistPendingProposal,
  getPendingProposal,
  listPendingProposals,
  verifyPendingProposal,
  verifyEventLedger,
  PENDING_PROPOSAL_ERRORS,
} from '../persistence/pending-proposals.js';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-pending-proposals-'));
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
    packet_id: packetId,
    node: 'Milly',
    source: 'cli',
    route,
    sia: 'ClaudeCodeSELF',
    execution_class: executionClass,
    intent: 'inspect the repo status',
    target: null,
    status: 'planned',
    created: '2026-07-09T23:00:00.000Z',
    parent_aecho: null,
    mutation,
    requires_approval: true,
    proof_required: ['stdout'],
    reason: 'matched inspect heuristic',
  };
  const routePlan = {
    route,
    sia: 'ClaudeCodeSELF',
    execution_class: executionClass,
    mutation,
    requires_approval: true,
    proof_required: ['stdout'],
    reason: 'matched inspect heuristic',
    status: 'planned',
  };
  const requestedExecution = { class: executionClass, mutation_requested: mutation };
  const origin = { self: 'ourself-agent-bridge', source: 'local-handshake-runner' };
  return {
    id: packetId,
    source: 'ourself-intake',
    origin,
    kind: 'proposal',
    executionClass,
    mutation,
    route,
    reason: routePlan.reason,
    requiresApproval: true,
    proof: ['stdout'],
    evidence: [],
    data: { packet, routePlan, requestedExecution },
    authority: { state: 'PENDING_HUMAN_TURN', human_turn_required: true },
  };
}

function buildReviewResult(overrides = {}) {
  const packetId = overrides.packetId || uniqueId();
  const proposal = overrides.proposal !== undefined
    ? overrides.proposal
    : buildProposal({ packetId, executionClass: overrides.executionClass, mutation: overrides.mutation, route: overrides.route });
  return {
    protocol: overrides.protocol ?? 'ourself.ae-kernel.v1',
    status: overrides.status ?? 'ACCEPTED_FOR_REVIEW',
    execution_performed: overrides.execution_performed ?? false,
    human_turn_required: overrides.human_turn_required ?? true,
    proposal,
  };
}

// ── Admission (1-5) ──────────────────────────────────────────────────────────

test('1-3. a valid authentic ACCEPTED_FOR_REVIEW proposal persists as PERSISTED_PENDING with authority still pending', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const result = await persistPendingProposal(dir, review, { kernelHead: 'ba27dbe', controlPlaneHead: '8dd9c1d' });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'PERSISTED_PENDING');
    assert.equal(result.record.state, 'PERSISTED_PENDING');
    assert.equal(result.record.authority.human_turn_required, true);
    assert.equal(result.record.authority.decision_state, 'PENDING');
    assert.equal(result.record.admission.status, 'ACCEPTED_FOR_REVIEW');
  });
});

test('4. execution remains false throughout admission and persistence', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.record.admission.status, 'ACCEPTED_FOR_REVIEW');
    assert.equal(review.execution_performed, false);
    assert.ok(!('execution_performed' in result.record) || result.record.execution_performed !== true);
  });
});

test('5. kernel and control-plane HEAD evidence is recorded on the persisted record', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const result = await persistPendingProposal(dir, review, {
      kernelHead: 'ba27dbe24b311b852b7558e8bd5721f09f1ae2ab',
      controlPlaneHead: '90a2f374d7bc1c09ba8373791e33737e2504aefd',
    });
    assert.equal(result.record.admission.kernel_head, 'ba27dbe24b311b852b7558e8bd5721f09f1ae2ab');
    assert.equal(result.record.admission.control_plane_head, '90a2f374d7bc1c09ba8373791e33737e2504aefd');
  });
});

// ── Rejection (6-13) ─────────────────────────────────────────────────────────

test('6. a REJECTED review result cannot persist', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult({ status: 'REJECTED' });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.PROPOSAL_NOT_ACCEPTED);
  });
});

test('7. a result with execution_performed: true cannot persist', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult({ execution_performed: true });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.EXECUTION_ALREADY_PERFORMED);
  });
});

test('8. a result with human_turn_required: false cannot persist', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult({ human_turn_required: false });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.HUMAN_TURN_INVARIANT_VIOLATION);
  });
});

test('9. invalid protocol cannot persist', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult({ protocol: 'ourself.ae-kernel.v2' });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.INVALID_PROTOCOL);
  });
});

test('10. invalid semantic checksum cannot persist', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const result = await persistPendingProposal(dir, review, { semanticChecksum: 'deadbeef'.repeat(8) });
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.INVALID_SEMANTIC_CHECKSUM);
  });
});

test('11. unknown execution class cannot persist', async () => {
  await withTempStore(async (dir) => {
    const packetId = uniqueId();
    const proposal = buildProposal({ packetId, executionClass: 'not_a_real_class' });
    const review = buildReviewResult({ packetId, proposal });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.UNKNOWN_EXECUTION_CLASS);
  });
});

test('12. incomplete proposal identity cannot persist', async () => {
  await withTempStore(async (dir) => {
    const packetId = uniqueId();
    const proposal = buildProposal({ packetId });
    delete proposal.data.packet.created;
    const review = buildReviewResult({ packetId, proposal });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.PROPOSAL_IDENTITY_INCOMPLETE);
  });
});

test('13. advisory/non-terminal execution class cannot persist', async () => {
  await withTempStore(async (dir) => {
    const packetId = uniqueId();
    const proposal = buildProposal({ packetId, executionClass: 'reverse_engineer', route: 'reverse_engineer' });
    const review = buildReviewResult({ packetId, proposal });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.UNKNOWN_EXECUTION_CLASS);
  });
});

test('13b. null execution class cannot persist (rejected as incomplete identity, since no class was bound at all)', async () => {
  await withTempStore(async (dir) => {
    const packetId = uniqueId();
    const proposal = buildProposal({ packetId });
    proposal.executionClass = null;
    proposal.data.requestedExecution.class = null;
    const review = buildReviewResult({ packetId, proposal });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.PROPOSAL_IDENTITY_INCOMPLETE);
  });
});

test('13c. non-null but unrecognized advisory execution class cannot persist as UNKNOWN_EXECUTION_CLASS', async () => {
  await withTempStore(async (dir) => {
    const packetId = uniqueId();
    const proposal = buildProposal({ packetId, executionClass: 'blueprint' });
    const review = buildReviewResult({ packetId, proposal });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.UNKNOWN_EXECUTION_CLASS);
  });
});

// ── Idempotency (14-16) ──────────────────────────────────────────────────────

test('14-15. repeating the identical proposal is idempotent and does not append a duplicate event', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const first = await persistPendingProposal(dir, review);
    const second = await persistPendingProposal(dir, review);
    assert.equal(first.ok, true);
    assert.equal(first.idempotent, false);
    assert.equal(second.ok, true);
    assert.equal(second.idempotent, true);
    assert.equal(second.code, PENDING_PROPOSAL_ERRORS.PROPOSAL_ALREADY_PERSISTED);

    const ledger = await verifyEventLedger(dir);
    assert.equal(ledger.eventCount, 1, 'second identical persist must not append a duplicate PROPOSAL_PERSISTED event');
  });
});

test('16. same proposal ID with altered content fails as an identity conflict', async () => {
  await withTempStore(async (dir) => {
    const packetId = uniqueId();
    const first = buildReviewResult({ packetId });
    await persistPendingProposal(dir, first);

    const conflicting = buildProposal({ packetId, executionClass: 'build' });
    const second = buildReviewResult({ packetId, proposal: conflicting });
    const result = await persistPendingProposal(dir, second);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.PROPOSAL_IDENTITY_CONFLICT);
  });
});

// ── Integrity (17-22) ────────────────────────────────────────────────────────

test('17. record hash verifies before tampering', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const persisted = await persistPendingProposal(dir, review);
    const verification = await verifyPendingProposal(dir, persisted.proposal_id);
    assert.equal(verification.valid, true);
  });
});

test('18. payload tampering is detected', async () => {
  await withTempStore(async (dir) => {
    const review = buildReviewResult();
    const persisted = await persistPendingProposal(dir, review);
    const path = join(dir, 'proposals', `${persisted.proposal_id}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.packet.intent = 'tampered intent, never authored by control plane';
    await writeFile(path, JSON.stringify(record, null, 2));

    const verification = await verifyPendingProposal(dir, persisted.proposal_id);
    assert.equal(verification.valid, false);
    assert.equal(verification.error, PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INTEGRITY_FAILURE);
    assert.ok(verification.details.includes('record_hash_mismatch'));
  });
});

test('19. event reordering across the store-wide ledger is detected', async () => {
  await withTempStore(async (dir) => {
    await persistPendingProposal(dir, buildReviewResult());
    await persistPendingProposal(dir, buildReviewResult());
    const ledgerPath = join(dir, 'events.jsonl');
    const lines = (await readFile(ledgerPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    const swapped = [lines[1], lines[0]].join('\n') + '\n';
    await writeFile(ledgerPath, swapped);

    const check = await verifyEventLedger(dir);
    assert.equal(check.valid, false);
    assert.equal(check.reason, 'previous_event_hash_mismatch');
  });
});

test('20. previous-hash mismatch is detected', async () => {
  await withTempStore(async (dir) => {
    await persistPendingProposal(dir, buildReviewResult());
    const ledgerPath = join(dir, 'events.jsonl');
    const event = JSON.parse((await readFile(ledgerPath, 'utf8')).trim());
    event.previous_event_hash = 'not-the-real-previous-hash';
    await writeFile(ledgerPath, JSON.stringify(event) + '\n');

    const check = await verifyEventLedger(dir);
    assert.equal(check.valid, false);
  });
});

test('21. malformed record is rejected safely without throwing, valid siblings are preserved', async () => {
  await withTempStore(async (dir) => {
    const good = await persistPendingProposal(dir, buildReviewResult());
    const badId = uniqueId('malformed');
    await mkdir(join(dir, 'proposals'), { recursive: true });
    await writeFile(join(dir, 'proposals', `${badId}.json`), '{ this is not valid json');

    const single = await getPendingProposal(dir, badId);
    assert.equal(single.ok, false);
    assert.equal(single.error, PENDING_PROPOSAL_ERRORS.PERSISTED_RECORD_INVALID);

    const listing = await listPendingProposals(dir);
    assert.equal(listing.proposals.some((p) => p.proposal_id === good.proposal_id), true);
    assert.equal(listing.corrupted.some((c) => c.proposal_id === badId), true);
  });
});

test('22. integrity failure never changes authority or execution state', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistPendingProposal(dir, buildReviewResult());
    const path = join(dir, 'proposals', `${persisted.proposal_id}.json`);
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.packet.route = 'build';
    await writeFile(path, JSON.stringify(record, null, 2));

    await verifyPendingProposal(dir, persisted.proposal_id);
    const after = await getPendingProposal(dir, persisted.proposal_id);
    assert.equal(after.record.authority.decision_state, 'PENDING');
    assert.equal(after.record.authority.human_turn_required, true);
  });
});

// ── Boundary (23-29) ─────────────────────────────────────────────────────────

test('23. path traversal via a crafted proposal id is rejected', async () => {
  await withTempStore(async (dir) => {
    const packetId = '../../etc/passwd';
    const proposal = buildProposal({ packetId });
    const review = buildReviewResult({ packetId, proposal });
    const result = await persistPendingProposal(dir, review);
    assert.equal(result.ok, false);
    assert.equal(result.error, PENDING_PROPOSAL_ERRORS.PERSISTENCE_BOUNDARY_VIOLATION);
  });
});

test('24. symlink escape is rejected rather than followed', async () => {
  await withTempStore(async (dir) => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'ourself-outside-'));
    try {
      const secretPath = join(outsideDir, 'secret.json');
      await writeFile(secretPath, JSON.stringify({ leaked: true }));
      await mkdir(join(dir, 'proposals'), { recursive: true });
      await symlink(secretPath, join(dir, 'proposals', 'evil.json'));

      const result = await getPendingProposal(dir, 'evil');
      assert.equal(result.ok, false);
      assert.equal(result.error, PENDING_PROPOSAL_ERRORS.PERSISTENCE_BOUNDARY_VIOLATION);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test('25-26. the module source never references the control-plane repo or a target-project path', async () => {
  const src = await readFile(new URL('../persistence/pending-proposals.js', import.meta.url), 'utf8');
  assert.equal(/ourself-agent-bridge/.test(src), false);
  assert.equal(/RUORA\/projects\//.test(src), false);
});

test('27. test storage is isolated from a second, independent storage root', async () => {
  await withTempStore(async (dirA) => {
    await withTempStore(async (dirB) => {
      const persisted = await persistPendingProposal(dirA, buildReviewResult());
      const lookupInB = await getPendingProposal(dirB, persisted.proposal_id);
      assert.equal(lookupInB.ok, false);
      assert.equal(lookupInB.error, PENDING_PROPOSAL_ERRORS.PROPOSAL_NOT_FOUND);
    });
  });
});

test('28-29. the module source never imports child_process or performs network calls', async () => {
  const src = await readFile(new URL('../persistence/pending-proposals.js', import.meta.url), 'utf8');
  assert.equal(/child_process|execSync|spawn\(/.test(src), false);
  assert.equal(/\bfetch\(|node:http|node:https/.test(src), false);
});

// ── Recovery and reads (30-34) ───────────────────────────────────────────────

test('30. a pending proposal can be retrieved by ID', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistPendingProposal(dir, buildReviewResult());
    const got = await getPendingProposal(dir, persisted.proposal_id);
    assert.equal(got.ok, true);
    assert.equal(got.record.proposal_id, persisted.proposal_id);
  });
});

test('31. a missing proposal returns deterministic not-found behavior', async () => {
  await withTempStore(async (dir) => {
    const got = await getPendingProposal(dir, uniqueId('missing'));
    assert.equal(got.ok, false);
    assert.equal(got.error, PENDING_PROPOSAL_ERRORS.PROPOSAL_NOT_FOUND);
  });
});

test('32. the pending list is deterministic and stable across repeated calls', async () => {
  await withTempStore(async (dir) => {
    await persistPendingProposal(dir, buildReviewResult());
    await persistPendingProposal(dir, buildReviewResult());
    await persistPendingProposal(dir, buildReviewResult());
    const first = await listPendingProposals(dir);
    const second = await listPendingProposals(dir);
    assert.deepEqual(first.proposals.map((p) => p.proposal_id), second.proposals.map((p) => p.proposal_id));
  });
});

test('33. recovery reconstructs valid pending state from records alone (no in-memory state required)', async () => {
  await withTempStore(async (dir) => {
    const a = await persistPendingProposal(dir, buildReviewResult());
    const b = await persistPendingProposal(dir, buildReviewResult());
    // Simulate a fresh process: this call holds no memory of the two calls above.
    const listing = await listPendingProposals(dir);
    const ids = listing.proposals.map((p) => p.proposal_id);
    assert.ok(ids.includes(a.proposal_id));
    assert.ok(ids.includes(b.proposal_id));
    assert.ok(listing.proposals.every((p) => p.state === 'PERSISTED_PENDING'));
  });
});

test('34. recovery reports corrupted state without executing or authorizing it', async () => {
  await withTempStore(async (dir) => {
    await persistPendingProposal(dir, buildReviewResult());
    await mkdir(join(dir, 'proposals'), { recursive: true });
    await writeFile(join(dir, 'proposals', `${uniqueId('corrupt')}.json`), 'not json at all');

    const listing = await listPendingProposals(dir);
    assert.equal(listing.corrupted.length, 1);
    assert.equal(listing.proposals.length, 1);
    // Structurally: this module has no execute/authorize capability at all —
    // recovery can only ever produce PERSISTED_PENDING records or corruption
    // reports, never an authority or execution state change.
    assert.ok(listing.proposals.every((p) => p.authority.decision_state === 'PENDING'));
  });
});
