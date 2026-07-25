// test/proof-path-driver.test.js
// ── SL-003: Synchronous Proof-Path Driver — proofs ──────────────────────────
// Every test uses its own isolated temp storageRoot and temp workspace OUTSIDE
// both live repositories and OUTSIDE the production SL-004 storage root.
// No fixture from any prior session is reused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createStaticHumanTurnTokenVerifier } from '../persistence/human-turn-decisions.js';
import { RECONCILIATION_STATUSES, OUTCOME_CLASSES } from '../persistence/execution-witness.js';
import { computeSemanticChecksum } from '../adapters/ourself-intake.js';
import {
  createProofPathDriver,
  DRIVER_VERSION,
  DRIVER_STAGES,
  DRIVER_ERRORS,
} from '../tools/proof-path-driver.js';

const TOKEN = 'human-turn-sl003-test-token-do-not-reuse';
const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_SOURCE_PATH = join(HERE, '..', 'tools', 'proof-path-driver.js');

// ── Fixtures (same shapes the T-030..T-033 suites established) ──────────────

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-proof-path-driver-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-sl003-workspace-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function uniqueId(label = 'sl003') {
  return `packet-${label}-${randomBytes(4).toString('hex')}`;
}

function buildProposal({ packetId, executionClass = 'git-read', route = 'git-read', mutation = false, intent = 'show git status of the repo' }) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route, sia: 'ClaudeCodeSELF',
    execution_class: executionClass, intent, target: null, status: 'planned',
    created: '2026-07-25T00:00:00.000Z', parent_aecho: null, mutation, requires_approval: true,
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

function decisionFor(proposalId, { decision = 'AUTHORIZE', presentedToken = TOKEN } = {}) {
  return {
    decision,
    decisionId: uniqueId('decision'),
    decidedBy: 'MYSELF',
    decidedAt: '2026-07-25T00:05:00.000Z',
    reason: 'Authorize isolated SL-003 proof only.',
    presentedToken,
  };
}

// ── Fake bounded-spawn implementations (same trusted seam as T-032/T-033) ───

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

const emitThen = (stdout, stderr, code) => (child) => {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code, null);
};
const behaviorExitZero = emitThen('fake ok\n', '', 0);

function driverFor(dir, ws, { proposalId, decision = 'AUTHORIZE', executionBehavior = behaviorExitZero, observationBehavior = behaviorExitZero } = {}) {
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision, expectedToken: TOKEN });
  return createProofPathDriver({
    storageRoot: dir,
    authorizedExecutionRoot: ws,
    verifyHumanTurnAuthorization: verifier,
    executionSpawnImpl: makeSpawnRecorder(executionBehavior),
    observationSpawnImpl: makeSpawnRecorder(observationBehavior),
  });
}

// ═════════════════════ Config validation (1-3) ══════════════════════════════

test('1. non-absolute storageRoot / executionRoot and missing verifier all throw TypeError', () => {
  const verifier = () => ({ ok: true });
  assert.throws(() => createProofPathDriver({ storageRoot: 'relative', authorizedExecutionRoot: '/a', verifyHumanTurnAuthorization: verifier }), TypeError);
  assert.throws(() => createProofPathDriver({ storageRoot: '/a', authorizedExecutionRoot: 'relative', verifyHumanTurnAuthorization: verifier }), TypeError);
  assert.throws(() => createProofPathDriver({ storageRoot: '/a', authorizedExecutionRoot: '/b' }), TypeError);
  assert.throws(() => createProofPathDriver({}), TypeError);
});

test('2. request must carry exactly one of envelope / reviewResult', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const driver = driverFor(dir, ws, { proposalId: 'unused' });
      const neither = await driver.runProofPath({ decision: decisionFor('x') });
      assert.equal(neither.ok, false);
      assert.equal(neither.error, DRIVER_ERRORS.INVALID_REQUEST);
      const both = await driver.runProofPath({ envelope: {}, reviewResult: {}, decision: decisionFor('x') });
      assert.equal(both.ok, false);
      assert.equal(both.error, DRIVER_ERRORS.INVALID_REQUEST);
    });
  });
});

test('3. incomplete decision input halts before any stage runs', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const driver = driverFor(dir, ws, { proposalId: 'unused' });
      const res = await driver.runProofPath({ reviewResult: buildReviewResult(), decision: { decision: 'AUTHORIZE' } });
      assert.equal(res.ok, false);
      assert.equal(res.error, DRIVER_ERRORS.INVALID_REQUEST);
      const entries = await readdir(dir);
      assert.deepEqual(entries, [], 'nothing may be persisted before request validation passes');
    });
  });
});

// ═════════════════════ Full-chain happy path (4-6) ══════════════════════════

test('4. AUTHORIZE runs all six stages and reconciles RECONCILED / SUCCESS_CONFIRMED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildReviewResult();
      const proposalId = review.proposal.id;
      const driver = driverFor(dir, ws, { proposalId });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, true, res.message || '');
      assert.equal(res.completed, true);
      assert.equal(res.driver_version, DRIVER_VERSION);
      assert.equal(res.proposal_id, proposalId);
      assert.equal(res.halted_at, null);
      assert.equal(res.outcome.reconciliation_status, RECONCILIATION_STATUSES.RECONCILED);
      assert.equal(res.outcome.outcome_class, OUTCOME_CLASSES.SUCCESS_CONFIRMED);
      for (const key of ['intake', 'persist', 'human_turn', 'execute', 'witness', 'reconcile']) {
        assert.ok(res.stages[key], `stage result missing: ${key}`);
      }
      assert.equal(res.stages.intake.skipped, true);
    });
  });
});

test('5. the full persisted chain cold-verifies through verifyProofChain', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildReviewResult();
      const proposalId = review.proposal.id;
      const driver = driverFor(dir, ws, { proposalId });
      const run = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(run.completed, true);
      const verified = await driver.verifyProofChain({ proposalId });
      assert.equal(verified.ok, true, JSON.stringify(verified.checks, null, 2));
      for (const [name, check] of Object.entries(verified.checks)) {
        assert.equal(check.ok, true, `${name} must verify ok`);
        assert.notEqual(check.valid, false, `${name} must not be invalid`);
      }
    });
  });
});

test('6. proof artifacts are durable files in the storageRoot, not process memory', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildReviewResult();
      const proposalId = review.proposal.id;
      const driver = driverFor(dir, ws, { proposalId });
      await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      const entries = await readdir(dir, { recursive: true });
      assert.ok(entries.length > 0, 'storageRoot must contain persisted artifacts');
      const ledgerName = entries.find((e) => e.endsWith('.jsonl'));
      assert.ok(ledgerName, 'a hash-chained ledger file must exist');
      const ledger = await readFile(join(dir, ledgerName), 'utf8');
      const events = ledger.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const types = events.map((e) => e.event_type ?? e.type);
      assert.ok(types.length >= 4, `expected the full event chain, got: ${types.join(', ')}`);
    });
  });
});

// ═════════════════════ Governance halts (7-9) ═══════════════════════════════

test('7. REJECT is a lawful halt: ok:true, completed:false, no execution artifacts', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildReviewResult();
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(behaviorExitZero);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'REJECT', expectedToken: TOKEN });
      const driver = createProofPathDriver({
        storageRoot: dir, authorizedExecutionRoot: ws,
        verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn,
      });
      const res = await driver.runProofPath({
        reviewResult: review,
        decision: decisionFor(proposalId, { decision: 'REJECT' }),
      });
      assert.equal(res.ok, true);
      assert.equal(res.completed, false);
      assert.equal(res.halted_at, 'HUMAN_TURN');
      assert.equal(res.outcome, 'REJECTED_BY_HUMAN_TURN');
      assert.equal(res.stages.execute, undefined, 'execution stage must never run');
      assert.equal(executionSpawn.calls.length, 0, 'no process may be spawned after REJECT');
    });
  });
});

test('8. a wrong presented token halts at HUMAN_TURN and never executes', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildReviewResult();
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(behaviorExitZero);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const driver = createProofPathDriver({
        storageRoot: dir, authorizedExecutionRoot: ws,
        verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn,
      });
      const res = await driver.runProofPath({
        reviewResult: review,
        decision: decisionFor(proposalId, { presentedToken: 'wrong-token' }),
      });
      assert.equal(res.ok, false);
      assert.equal(res.halted_at, 'HUMAN_TURN');
      assert.equal(res.error, DRIVER_ERRORS.STAGE_FAILED);
      assert.equal(res.stages.execute, undefined);
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

test('9. a rejected intake envelope halts at INTAKE with nothing persisted', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const driver = driverFor(dir, ws, { proposalId: 'unused' });
      const res = await driver.runProofPath({
        envelope: { protocol: 'wrong.protocol.v0' },
        decision: decisionFor('unused'),
      });
      assert.equal(res.ok, false);
      assert.equal(res.halted_at, 'INTAKE');
      assert.equal(res.error, DRIVER_ERRORS.INTAKE_REJECTED);
      const entries = await readdir(dir);
      assert.deepEqual(entries, [], 'a rejected envelope must persist nothing');
    });
  });
});

// ═════════════════════ Intake path with a valid envelope (10) ═══════════════

test('10. a valid OURSELF envelope flows through intake into the full chain', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const packetId = uniqueId('intake');
      const packet = {
        packet_id: packetId, created: '2026-07-25T00:00:00.000Z', route: 'git-read',
        execution_class: 'git-read', status: 'planned', node: 'Milly', source: 'cli',
        raw_text: 'show git status', target: null, risk: 'low', parent_aecho: null,
      };
      const routePlan = {
        route: 'git-read', execution_class: 'git-read', mutation: false, requires_approval: true,
        reason: 'Read-only git inspection', status: 'planned', sia: 'ClaudeCodeSELF', proof_required: ['stdout'],
      };
      const requestedExecution = { class: 'git-read', mutation_requested: false };
      const envelope = {
        protocol: 'ourself.ae-kernel.v1',
        packet, route_plan: routePlan,
        origin: { self: 'ourself-agent-bridge', source: 'cli-mouth' },
        authority: { state: 'PENDING_HUMAN_TURN', human_turn_required: true },
        requested_execution: requestedExecution,
        expected_evidence: ['stdout'],
        semantic_checksum: computeSemanticChecksum(packet, routePlan, requestedExecution),
      };
      const driver = driverFor(dir, ws, { proposalId: packetId });
      const res = await driver.runProofPath({ envelope, decision: decisionFor(packetId) });
      assert.equal(res.ok, true, res.message || JSON.stringify(res.stages.intake));
      assert.equal(res.completed, true);
      assert.equal(res.stages.intake.status, 'ACCEPTED_FOR_REVIEW');
      assert.equal(res.outcome.reconciliation_status, RECONCILIATION_STATUSES.RECONCILED);
    });
  });
});

// ═════════════════════ Divergence is reported, never remediated (11) ════════

test('11. divergent witness output completes with RECONCILIATION_DIVERGED reported verbatim', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildReviewResult();
      const proposalId = review.proposal.id;
      const driver = driverFor(dir, ws, {
        proposalId,
        executionBehavior: emitThen('?? state-a.txt\n', '', 0),
        observationBehavior: emitThen('?? state-b.txt\n', '', 0),
      });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, true);
      assert.equal(res.completed, true);
      assert.equal(res.outcome.reconciliation_status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      assert.equal(res.outcome.outcome_class, null);
    });
  });
});

// ═════════════════════ SL-003 containment law (12-13) ═══════════════════════

test('12. containment law: driver source never references queue-store or orchestrator', () => {
  const source = readFileSync(DRIVER_SOURCE_PATH, 'utf8');
  const importLines = source.split('\n').filter((l) => /^\s*import\b|\brequire\s*\(/.test(l));
  for (const line of importLines) {
    assert.ok(!line.includes('queue-store'), `forbidden import: ${line.trim()}`);
    assert.ok(!line.includes('orchestrator'), `forbidden import: ${line.trim()}`);
    assert.ok(!/runtime\//.test(line), `forbidden runtime/* import: ${line.trim()}`);
  }
});

test('13. driver stage vocabulary is frozen and complete', () => {
  assert.deepEqual([...DRIVER_STAGES], ['INTAKE', 'PERSIST', 'HUMAN_TURN', 'EXECUTE', 'WITNESS', 'RECONCILE']);
  assert.ok(Object.isFrozen(DRIVER_STAGES));
});
