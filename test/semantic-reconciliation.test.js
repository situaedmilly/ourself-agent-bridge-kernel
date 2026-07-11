// test/semantic-reconciliation.test.js
// ── T-033 (part 2): Durable Semantic Reconciliation — targeted proof suite ──
// Every test uses its own isolated temp storageRoot and temp workspace OUTSIDE
// both live repositories. No fixture from any prior session is reused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, eventsLedgerPath, verifyEventLedger, verifyPendingProposal } from '../persistence/pending-proposals.js';
import { createStaticHumanTurnTokenVerifier, createHumanTurnDecisionService, DECISION_VERSION } from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import {
  EXECUTION_WITNESS_ERRORS as WERR,
  RECONCILIATION_STATUSES,
  OUTCOME_CLASSES,
  INDETERMINATE_REASONS,
  WITNESS_PROFILES,
  computeProfileReconciliation,
} from '../persistence/execution-witness.js';
import {
  createExecutionWitnessService,
  recordSemanticReconciliation,
  getSemanticReconciliationState,
  verifySemanticReconciliation,
  computeReconciliationHash,
  SEMANTIC_RECONCILIATION_ERRORS as RERR,
  RECONCILIATION_VERSION,
  BOUNDED_RECONCILIATION_CLAIM,
} from '../persistence/semantic-reconciliation.js';

const TOKEN = 'human-turn-t033-test-token-do-not-reuse';

// ── Fixtures (same shapes the T-030/T-031/T-032 suites established) ─────────

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-semantic-reconciliation-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-t033-ws-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function uniqueId(label = 't033r') {
  return `packet-${label}-${randomBytes(4).toString('hex')}`;
}

function buildProposal({ packetId, executionClass = 'git-read', route = 'git-read', mutation = false, intent = 'show git status of the repo' }) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route, sia: 'ClaudeCodeSELF',
    execution_class: executionClass, intent, target: null, status: 'planned',
    created: '2026-07-11T00:00:00.000Z', parent_aecho: null, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched route heuristic',
  };
  const routePlan = {
    route, sia: 'ClaudeCodeSELF', execution_class: executionClass, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched route heuristic', status: 'planned',
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
  const proposal = buildProposal({ packetId, ...overrides });
  return {
    protocol: 'ourself.ae-kernel.v1', status: 'ACCEPTED_FOR_REVIEW', execution_performed: false,
    human_turn_required: true, proposal,
  };
}

function decisionFor(record, { decision }) {
  const latestEvent = record.events[record.events.length - 1];
  return {
    decision_version: DECISION_VERSION,
    decision_id: uniqueId('decision'),
    proposal_id: record.proposal_id,
    decision,
    decided_by: 'MYSELF',
    decided_at: '2026-07-11T00:05:00.000Z',
    proposal_integrity: {
      record_hash: record.integrity.record_hash,
      semantic_checksum: record.semantic_checksum,
      latest_event_hash: latestEvent.event_hash,
    },
    reason: 'Authorize isolated T-033 proof only.',
    constraints: [],
  };
}

// ── Fake bounded-spawn implementations (trusted-construction test seam) ─────

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {
    child.emit('close', null, 'SIGKILL');
    return true;
  };
  return child;
}

function makeSpawnRecorder(behavior) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    const child = fakeChild();
    calls.push({ cmd, args, opts });
    setImmediate(() => behavior(child, calls));
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

const emit = (stdout, stderr, code) => (child) => {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code, null);
};
const behaviorExitZero = emit('fake ok\n', '', 0);
const behaviorNeverExit = () => { /* only the timeout SIGKILL ends it */ };

/** Persist + AUTHORIZE + EXECUTE + (optionally) WITNESS through the real chain. */
async function witnessedProposal(dir, ws, {
  executionBehavior = behaviorExitZero,
  observationBehavior = behaviorExitZero,
  witness = true,
  serviceOpts = {},
} = {}) {
  const persisted = await persistPendingProposal(dir, buildReviewResult());
  assert.equal(persisted.ok, true);
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId: persisted.proposal_id, decision: 'AUTHORIZE', expectedToken: TOKEN });
  const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
  const decided = await service.recordHumanTurnDecision({
    storageRoot: dir, proposalId: persisted.proposal_id,
    decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }), presentedToken: TOKEN,
  });
  assert.equal(decided.ok, true, decided.error || '');
  const { executeAuthorizedProposal } = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: makeSpawnRecorder(executionBehavior) });
  const executed = await executeAuthorizedProposal({ storageRoot: dir, proposalId: persisted.proposal_id });
  assert.equal(executed.ok, true, executed.message || '');
  let captured = null;
  const obsSpawn = makeSpawnRecorder(observationBehavior);
  if (witness) {
    const { captureExecutionWitness } = createExecutionWitnessService({ authorizedObservationRoot: ws, spawnImpl: obsSpawn, ...serviceOpts });
    captured = await captureExecutionWitness({ storageRoot: dir, proposalId: persisted.proposal_id });
    assert.equal(captured.ok, true, captured.message || '');
  }
  return { proposalId: persisted.proposal_id, executed, captured, obsSpawn };
}

// ═══════════════ Verdict law: the three statuses (1-6) ══════════════════════

test('1. matching successful execution reconciles as RECONCILED / SUCCESS_CONFIRMED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILED);
      assert.equal(res.outcome_class, OUTCOME_CLASSES.SUCCESS_CONFIRMED);
      assert.equal(res.reconciliation.bounded_claim, BOUNDED_RECONCILIATION_CLAIM);
      assert.equal(res.reconciliation.reconciliation_version, RECONCILIATION_VERSION);
    });
  });
});

test('2. matching failed execution reconciles as RECONCILED / FAILURE_CONFIRMED by failure class', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const failing = emit('', 'fatal: not a git repository (or any of the parent directories): .git\n', 128);
      const { proposalId } = await witnessedProposal(dir, ws, { executionBehavior: failing, observationBehavior: failing });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILED);
      assert.equal(res.outcome_class, OUTCOME_CLASSES.FAILURE_CONFIRMED);
      assert.deepEqual(res.reconciliation.compared_fields, ['failure_class']);
    });
  });
});

test('3. divergent stdout yields RECONCILIATION_DIVERGED with a bounded divergence report', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, {
        executionBehavior: emit('?? state-a.txt\n', '', 0),
        observationBehavior: emit('?? state-b.txt\n', '', 0),
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      assert.equal(res.outcome_class, null);
      assert.equal(res.reconciliation.divergence.field, 'stdout');
      assert.equal(res.reconciliation.divergence.line, 1);
      assert.ok(res.reconciliation.divergence.recorded_value_excerpt.length <= 200);
    });
  });
});

test('4. an observation timeout yields RECONCILIATION_INDETERMINATE / OBSERVATION_TIMEOUT — never success', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, {
        observationBehavior: behaviorNeverExit,
        serviceOpts: { timeoutMs: 50 },
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_INDETERMINATE);
      assert.equal(res.reconciliation.indeterminate_reason, INDETERMINATE_REASONS.OBSERVATION_TIMEOUT);
      assert.equal(res.outcome_class, null);
    });
  });
});

test('5. divergent exit code (recorded success, observed failure) diverges on exit_code', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, {
        executionBehavior: emit('ok\n', '', 0),
        observationBehavior: emit('', 'boom\n', 2),
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      assert.equal(res.reconciliation.divergence.field, 'exit_code');
    });
  });
});

test('6. CRLF-vs-LF output differences reconcile under the versioned normalization law', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, {
        executionBehavior: emit('?? a.txt\n?? b.txt\n', '', 0),
        observationBehavior: emit('?? a.txt\r\n?? b.txt\r\n', '', 0),
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILED);
    });
  });
});

// ═══════════════ Persistence, events, and integrity (7-11) ══════════════════

test('7. reconciliation persists a hash-bound block, a ledger event, and a valid record hash', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(computeReconciliationHash(res.reconciliation), res.reconciliation.reconciliation_hash);
      const lastEvent = res.record.events[res.record.events.length - 1];
      assert.equal(lastEvent.type, 'RECONCILED');
      assert.equal(lastEvent.reconciliation_hash, res.reconciliation.reconciliation_hash);
      assert.equal((await verifyPendingProposal(dir, proposalId)).valid, true);
      assert.equal((await verifyEventLedger(dir)).valid, true);
      const verified = await verifySemanticReconciliation(dir, proposalId);
      assert.deepEqual(verified, { ok: true, valid: true, reconciled: true });
    });
  });
});

test('8. reconciliation before witness fails closed (WITNESS_NOT_CAPTURED)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, { witness: false });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, false);
      assert.equal(res.error, RERR.WITNESS_NOT_CAPTURED);
    });
  });
});

test('9. reconciliation is one-shot: a repeat returns the recorded verdict without recomputing-and-rewriting', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      const first = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(first.ok, true, first.message);
      const ledgerBefore = await readFile(eventsLedgerPath(dir), 'utf8');
      const second = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(second.ok, true);
      assert.equal(second.idempotent, true);
      assert.equal(second.code, RERR.RECONCILIATION_ALREADY_RECORDED);
      assert.equal(second.reconciliation.reconciliation_hash, first.reconciliation.reconciliation_hash);
      assert.equal(await readFile(eventsLedgerPath(dir), 'utf8'), ledgerBefore, 'no duplicate ledger event');
    });
  });
});

test('10. a pre-existing reconciliation claim blocks a fresh verdict (no auto-recovery, claim preserved)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      await mkdir(join(dir, 'reconciliations'), { recursive: true });
      await writeFile(join(dir, 'reconciliations', `${proposalId}.lock`), '{"stale":true}\n');
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, false);
      assert.equal(res.error, RERR.CONCURRENT_RECONCILIATION_CONFLICT);
      const raw = await readFile(join(dir, 'reconciliations', `${proposalId}.lock`), 'utf8');
      assert.equal(raw, '{"stale":true}\n', 'the module never deletes or repairs a claim');
    });
  });
});

test('11. reconciliation request cannot override the law (forbidden fields fail closed)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      for (const field of ['witness', 'reconciliation', 'plan', 'profile', 'token', 'presentedToken', 'normalization_version']) {
        const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId, [field]: 'x' });
        assert.equal(res.ok, false, `field ${field} must be rejected`);
        assert.equal(res.error, WERR.WITNESS_OVERRIDE_FORBIDDEN);
      }
    });
  });
});

// ═══════ No rollback, no retry, no state rewrite, no model (12-14) ══════════

test('12. a DIVERGED verdict triggers no rollback, no retry, and no execution mutation', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId, executed } = await witnessedProposal(dir, ws, {
        executionBehavior: emit('recorded\n', '', 0),
        observationBehavior: emit('observed\n', '', 0),
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      assert.deepEqual(res.record.execution.result, executed.record.execution.result, 'execution result untouched');
      assert.equal(res.record.state, executed.record.state, 'record.state never rewritten');
      assert.deepEqual(res.record.authority, executed.record.authority, 'authority untouched');
      const executionEvents = res.record.events.filter((e) => e.type === 'EXECUTION_STARTED');
      assert.equal(executionEvents.length, 1, 'no execution retry after divergence');
    });
  });
});

test('13. the verdict is deterministic: identical persisted inputs always recompute identically', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      const record = res.record;
      const profile = WITNESS_PROFILES[record.witness.witness_profile_id];
      const a = computeProfileReconciliation({ profile, recordedResult: record.execution.result, witnessPacket: record.witness });
      const b = computeProfileReconciliation({ profile, recordedResult: record.execution.result, witnessPacket: record.witness });
      assert.deepEqual(a, b);
      assert.equal(a.status, record.reconciliation.status);
      assert.equal(a.outcome_class, record.reconciliation.outcome_class);
    });
  });
});

test('14. a tampered persisted verdict is caught: the stored status must be reproducible, never trusted', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, {
        executionBehavior: emit('recorded\n', '', 0),
        observationBehavior: emit('observed\n', '', 0),
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      // Forge the verdict to RECONCILED while keeping its own hash consistent.
      const path = join(dir, 'proposals', `${proposalId}.json`);
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.reconciliation.status = 'RECONCILED';
      record.reconciliation.outcome_class = 'SUCCESS_CONFIRMED';
      record.reconciliation.divergence = null;
      record.reconciliation.reconciliation_hash = computeReconciliationHash(record.reconciliation);
      await writeFile(path, JSON.stringify(record, null, 2));
      const verified = await verifySemanticReconciliation(dir, proposalId);
      assert.equal(verified.valid, false);
      assert.ok(verified.details.includes('reconciliation_status_not_reproducible'), JSON.stringify(verified.details));
    });
  });
});

// ═══════ Crash-resume and interruption laws (15-18) ═════════════════════════

test('15. crash-resume: a fresh caller reconciles from the persisted witness with zero new observation', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      // Session 1: witness captured, then "crash" before reconciliation.
      const { proposalId } = await witnessedProposal(dir, ws);
      // Session 2: fresh reconciliation directly from persisted state.
      const spy = makeSpawnRecorder(behaviorExitZero);
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILED);
      assert.equal(spy.calls.length, 0, 'reconciliation never spawns a process');
    });
  });
});

test('16. interruption after execution but before witness leaves a cleanly resumable store', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, { witness: false });
      // The interrupted store: terminal execution, no witness dir, no claim, clean hashes.
      const entries = (await readdir(dir)).sort();
      assert.deepEqual(entries, ['events.jsonl', 'executions', 'proposals'], 'no witness artifact exists before capture');
      assert.equal((await verifyPendingProposal(dir, proposalId)).valid, true);
      assert.equal((await verifyEventLedger(dir)).valid, true);
      // A fresh service continues lawfully from this exact state.
      const { captureExecutionWitness } = createExecutionWitnessService({ authorizedObservationRoot: ws, spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const captured = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(captured.ok, true, captured.message);
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
    });
  });
});

test('17. getSemanticReconciliationState reads the full lifecycle without mutating anything', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws, { witness: false });
      let state = await getSemanticReconciliationState(dir, proposalId);
      assert.deepEqual([state.witnessed, state.reconciled, state.status], [false, false, null]);
      const { captureExecutionWitness } = createExecutionWitnessService({ authorizedObservationRoot: ws, spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      await captureExecutionWitness({ storageRoot: dir, proposalId });
      state = await getSemanticReconciliationState(dir, proposalId);
      assert.deepEqual([state.witnessed, state.reconciled], [true, false]);
      const hashBefore = state.record.integrity.record_hash;
      await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      state = await getSemanticReconciliationState(dir, proposalId);
      assert.deepEqual([state.witnessed, state.reconciled, state.status], [true, true, 'RECONCILED']);
      assert.notEqual(state.record.integrity.record_hash, hashBefore);
      const again = await getSemanticReconciliationState(dir, proposalId);
      assert.equal(again.record.integrity.record_hash, state.record.integrity.record_hash, 'reads are pure');
    });
  });
});

test('18. verifySemanticReconciliation reports reconciled:false (valid) before any verdict exists', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await witnessedProposal(dir, ws);
      const res = await verifySemanticReconciliation(dir, proposalId);
      assert.deepEqual(res, { ok: true, valid: true, reconciled: false });
    });
  });
});

// ═══════ Truncation indeterminacy (19-20) ═══════════════════════════════════

test('19. truncated recorded output yields RECONCILIATION_INDETERMINATE / RECORDED_OUTPUT_TRUNCATED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const persisted = await persistPendingProposal(dir, buildReviewResult());
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId: persisted.proposal_id, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
      await service.recordHumanTurnDecision({
        storageRoot: dir, proposalId: persisted.proposal_id,
        decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }), presentedToken: TOKEN,
      });
      const huge = (child) => { child.stdout.emit('data', Buffer.alloc(4096, 0x61)); child.emit('close', 0, null); };
      const { executeAuthorizedProposal } = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: makeSpawnRecorder(huge), maxOutputBytes: 100 });
      const executed = await executeAuthorizedProposal({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(executed.ok, true);
      assert.equal(executed.result.stdout_truncated, true);
      const { captureExecutionWitness } = createExecutionWitnessService({ authorizedObservationRoot: ws, spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const captured = await captureExecutionWitness({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(captured.ok, true, captured.message);
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_INDETERMINATE);
      assert.equal(res.reconciliation.indeterminate_reason, INDETERMINATE_REASONS.RECORDED_OUTPUT_TRUNCATED);
    });
  });
});

test('20. truncated witness output yields RECONCILIATION_INDETERMINATE / WITNESS_OUTPUT_TRUNCATED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const huge = (child) => { child.stdout.emit('data', Buffer.alloc(4096, 0x61)); child.emit('close', 0, null); };
      const { proposalId } = await witnessedProposal(dir, ws, {
        observationBehavior: huge,
        serviceOpts: { maxOutputBytes: 100 },
      });
      const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId });
      assert.equal(res.status, RECONCILIATION_STATUSES.RECONCILIATION_INDETERMINATE);
      assert.equal(res.reconciliation.indeterminate_reason, INDETERMINATE_REASONS.WITNESS_OUTPUT_TRUNCATED);
    });
  });
});
