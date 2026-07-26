// test/git-add-execution.test.js
// ── SL-008A: git-add Authority Expansion — proofs ───────────────────────────
// Every test uses its own isolated temp storageRoot and temp workspace OUTSIDE
// both live repositories and OUTSIDE the production SL-004 storage root.
// Spawn is FAKE throughout (same discipline as every T-032/T-033 test) — no
// real git binary runs here. No fixture from any prior session is reused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { unlinkSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, getPendingProposal } from '../persistence/pending-proposals.js';
import { createStaticHumanTurnTokenVerifier, createHumanTurnDecisionService, DECISION_VERSION } from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import { RECONCILIATION_STATUSES, OUTCOME_CLASSES } from '../persistence/execution-witness.js';
import { createProofPathDriver } from '../tools/proof-path-driver.js';

const TOKEN = 'human-turn-sl008a-test-token-do-not-reuse';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-sl008a-store-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-sl008a-workspace-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function uniqueId(label = 'sl008a') {
  return `packet-${label}-${randomBytes(4).toString('hex')}`;
}

// Direct proposal construction (per SL-008A's approved intake-scope decision:
// no route-classifier.js involvement this gate) — same technique the sealed
// T-030..T-033 suites already use for git-read/inspect fixtures.
function buildGitAddReviewResult({ packetId, target, mutation = true }) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route: 'git-add', sia: 'ClaudeCodeSELF',
    execution_class: 'git-write-local', intent: 'stage a tracked file change', target, status: 'planned',
    created: '2026-07-25T00:00:00.000Z', parent_aecho: null, mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'authorized git-add primitive (SL-008A)',
  };
  const routePlan = {
    route: 'git-add', sia: 'ClaudeCodeSELF', execution_class: 'git-write-local', mutation, requires_approval: true,
    proof_required: ['stdout'], reason: 'authorized git-add primitive (SL-008A)', status: 'planned',
  };
  const requestedExecution = { class: 'git-write-local', mutation_requested: mutation };
  const origin = { self: 'ourself-agent-bridge', source: 'local-handshake-runner' };
  return {
    protocol: 'ourself.ae-kernel.v1', status: 'ACCEPTED_FOR_REVIEW', execution_performed: false, human_turn_required: true,
    proposal: {
      id: packetId, source: 'ourself-intake', origin, kind: 'proposal', executionClass: 'git-write-local', mutation, route: 'git-add',
      reason: routePlan.reason, requiresApproval: true, proof: ['stdout'], evidence: [],
      data: { packet, routePlan, requestedExecution },
      authority: { state: 'PENDING_HUMAN_TURN', human_turn_required: true },
    },
  };
}

function decisionFor(proposalId, overrides = {}) {
  return {
    decision: 'AUTHORIZE',
    decisionId: uniqueId('decision'),
    decidedBy: 'MYSELF',
    decidedAt: '2026-07-25T00:05:00.000Z',
    reason: 'Authorize isolated SL-008A git-add proof only.',
    presentedToken: TOKEN,
    ...overrides,
  };
}

// ── Fake bounded-spawn (same trusted seam as every sealed T-032/T-033 test) ──
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.emit('close', null, 'SIGKILL'); return true; };
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
const gitAddSuccess = emitThen('', '', 0); // git add is silent on success — by design, not a fixture gap.
const statusShowsStaged = (relPath) => emitThen(`A  ${relPath}\n`, '', 0);
const statusShowsSomethingElseStaged = emitThen('A  some-other-file.txt\n', '', 0);
const statusShowsNothingStaged = emitThen('', '', 0);

async function driverFor(dir, ws, { proposalId, decision = 'AUTHORIZE', executionBehavior = gitAddSuccess, observationBehavior }) {
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision, expectedToken: TOKEN });
  return createProofPathDriver({
    storageRoot: dir,
    authorizedExecutionRoot: ws,
    verifyHumanTurnAuthorization: verifier,
    executionSpawnImpl: makeSpawnRecorder(executionBehavior),
    observationSpawnImpl: makeSpawnRecorder(observationBehavior),
  });
}

// Persists + authorizes a git-add proposal WITHOUT executing it — the fixture
// used by the pre-spawn revalidation tests, which need to drive
// executeAuthorizedProposal() directly so they can inject a custom `now`.
async function authorizeGitAddProposal(dir, target) {
  const review = buildGitAddReviewResult({ packetId: uniqueId(), target });
  const proposalId = review.proposal.id;
  const persisted = await persistPendingProposal(dir, review);
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
  const decisionService = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
  await decisionService.recordHumanTurnDecision({
    storageRoot: dir, proposalId,
    decisionInput: {
      decision_version: DECISION_VERSION, decision_id: uniqueId('decision'), proposal_id: proposalId,
      decision: 'AUTHORIZE', decided_by: 'MYSELF', decided_at: '2026-07-25T00:05:00.000Z',
      proposal_integrity: {
        record_hash: persisted.record.integrity.record_hash,
        semantic_checksum: persisted.record.semantic_checksum,
        latest_event_hash: persisted.record.events[persisted.record.events.length - 1].event_hash,
      },
      reason: 'test', constraints: [],
    },
    presentedToken: TOKEN,
  });
  return proposalId;
}

// A `now` seam that fires a synchronous filesystem side effect exactly once
// (on its first call — which lands at plan.created_at, right after the
// FIRST target validation succeeds and well before pre-spawn revalidation
// runs) then behaves as an ordinary fixed clock for every later call.
function onceThenNow(sideEffect) {
  let fired = false;
  return () => {
    if (!fired) { fired = true; sideEffect(); }
    return '2026-07-25T00:10:00.000Z';
  };
}

// ═══════════════════════ 1. correctness — stages only the sealed path ═══════

test('1. authorized git-add stages exactly the sealed path and reconciles SUCCESS_CONFIRMED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const driver = await driverFor(dir, ws, { proposalId, observationBehavior: statusShowsStaged('file.txt') });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, true, res.message || JSON.stringify(res.stages, null, 2));
      assert.equal(res.completed, true);
      assert.equal(res.outcome.reconciliation_status, RECONCILIATION_STATUSES.RECONCILED);
      assert.equal(res.outcome.outcome_class, OUTCOME_CLASSES.SUCCESS_CONFIRMED);
      assert.deepEqual(res.stages.execute.plan?.argv ?? null, res.stages.execute.plan?.argv, 'sanity');
    });
  });
});

test('1b. the derived plan argv is exactly ["add", "--", <one path>] — no extra arguments', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const persisted = await persistPendingProposal(dir, review);
      const decisionService = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
      await decisionService.recordHumanTurnDecision({
        storageRoot: dir, proposalId,
        decisionInput: {
          decision_version: DECISION_VERSION, decision_id: uniqueId('decision'), proposal_id: proposalId,
          decision: 'AUTHORIZE', decided_by: 'MYSELF', decided_at: '2026-07-25T00:05:00.000Z',
          proposal_integrity: {
            record_hash: persisted.record.integrity.record_hash,
            semantic_checksum: persisted.record.semantic_checksum,
            latest_event_hash: persisted.record.events[persisted.record.events.length - 1].event_hash,
          },
          reason: 'test', constraints: [],
        },
        presentedToken: TOKEN,
      });
      const executor = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: executionSpawn });
      const executed = await executor.executeAuthorizedProposal({ storageRoot: dir, proposalId });
      assert.equal(executed.ok, true, executed.message);
      assert.deepEqual(executed.plan.argv, ['add', '--', 'file.txt']);
      assert.equal(executionSpawn.calls.length, 1);
      assert.deepEqual(executionSpawn.calls[0].args, ['add', '--', 'file.txt']);
    });
  });
});

// ═══════════════════════ 2. unauthorized never spawns ═══════════════════════

test('2. an unauthorized (wrong-token) request never spawns git', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const driver = createProofPathDriver({
        storageRoot: dir, authorizedExecutionRoot: ws,
        verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn,
      });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId, { presentedToken: 'wrong-token' }) });
      assert.equal(res.ok, false);
      assert.equal(res.halted_at, 'HUMAN_TURN');
      assert.equal(executionSpawn.calls.length, 0, 'no process may be spawned without a valid Human_TURN');
    });
  });
});

// ═══════════════════════ 3. REJECT halts before execution ═══════════════════

test('3. REJECT is a lawful halt: no git-add ever spawns', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'REJECT', expectedToken: TOKEN });
      const driver = createProofPathDriver({
        storageRoot: dir, authorizedExecutionRoot: ws,
        verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn,
      });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId, { decision: 'REJECT' }) });
      assert.equal(res.ok, true);
      assert.equal(res.completed, false);
      assert.equal(res.outcome, 'REJECTED_BY_HUMAN_TURN');
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

// ═══════════════════════ 4. witness captures post-stage state ═══════════════

test('4. witness independently captures the post-stage index via the new profile', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const driver = await driverFor(dir, ws, { proposalId, observationBehavior: statusShowsStaged('file.txt') });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.completed, true);
      assert.equal(res.stages.witness.ok, true);
      assert.equal(res.stages.witness.witness.witness_profile_id, 'git-add-status-short.witness.v1');
    });
  });
});

// ═══════════════════════ 5. reconciliation is path-specific, not index-generic ═

test('5a. reconciliation SUCCESS_CONFIRMED only when the SEALED target specifically is staged', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const driver = await driverFor(dir, ws, { proposalId, observationBehavior: statusShowsStaged('file.txt') });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.outcome.outcome_class, OUTCOME_CLASSES.SUCCESS_CONFIRMED);
    });
  });
});

test('5b. a DIFFERENT staged path (simulated tamper) reconciles as DIVERGED, never auto-fixed', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const driver = await driverFor(dir, ws, { proposalId, observationBehavior: statusShowsSomethingElseStaged });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.completed, true, 'reconciliation runs and records a verdict — it does not halt the chain');
      assert.equal(res.outcome.reconciliation_status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      assert.equal(res.outcome.outcome_class, null);
      const verified = await driver.verifyProofChain({ proposalId });
      assert.equal(verified.checks.semantic_reconciliation.ok, true);
      assert.equal(verified.checks.semantic_reconciliation.reconciled, true, 'DIVERGED is itself a valid, durable, cold-verifiable verdict');
    });
  });
});

test('5c. nothing staged at all reconciles as DIVERGED, never SUCCESS_CONFIRMED', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const driver = await driverFor(dir, ws, { proposalId, observationBehavior: statusShowsNothingStaged });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.outcome.reconciliation_status, RECONCILIATION_STATUSES.RECONCILIATION_DIVERGED);
      assert.equal(res.outcome.outcome_class, null);
    });
  });
});

// ═══════════════════════ 6. cold verification reproduces the chain ══════════

test('6. the full git-add chain cold-verifies via verifyProofChain', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'file.txt' });
      const proposalId = review.proposal.id;
      const driver = await driverFor(dir, ws, { proposalId, observationBehavior: statusShowsStaged('file.txt') });
      const run = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(run.completed, true);
      const verified = await driver.verifyProofChain({ proposalId });
      assert.equal(verified.ok, true, JSON.stringify(verified.checks, null, 2));
    });
  });
});

// ═══════════════════════ 7. secret-path target refused before any spawn ═════

test('7a. a .env target is refused before any spawn (literal-string check)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, '.env'), 'SECRET=1\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: '.env' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const driver = createProofPathDriver({ storageRoot: dir, authorizedExecutionRoot: ws, verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, false);
      assert.equal(res.halted_at, 'EXECUTE');
      assert.equal(res.error, 'STAGE_FAILED');
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

test('7b. a credentials.json target is refused before any spawn', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'credentials.json'), '{}\n');
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'credentials.json' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const driver = createProofPathDriver({ storageRoot: dir, authorizedExecutionRoot: ws, verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, false);
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

// ═══════════════════════ 8. boundary + regular-file + symlink law ═══════════

test('8a. a target outside authorizedExecutionRoot is refused before any spawn', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await withTempWorkspace(async (outside) => {
        await writeFile(join(outside, 'escape.txt'), 'x\n');
        const review = buildGitAddReviewResult({ packetId: uniqueId(), target: join(outside, 'escape.txt') });
        const proposalId = review.proposal.id;
        const executionSpawn = makeSpawnRecorder(gitAddSuccess);
        const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
        const driver = createProofPathDriver({ storageRoot: dir, authorizedExecutionRoot: ws, verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn });
        const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
        assert.equal(res.ok, false);
        assert.equal(executionSpawn.calls.length, 0);
      });
    });
  });
});

test('8b. a symlinked target is refused before any spawn', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await withTempWorkspace(async (outside) => {
        const realFile = join(outside, 'real.txt');
        await writeFile(realFile, 'x\n');
        const linkPath = join(ws, 'link.txt');
        await symlink(realFile, linkPath);
        const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'link.txt' });
        const proposalId = review.proposal.id;
        const executionSpawn = makeSpawnRecorder(gitAddSuccess);
        const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
        const driver = createProofPathDriver({ storageRoot: dir, authorizedExecutionRoot: ws, verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn });
        const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
        assert.equal(res.ok, false);
        assert.equal(executionSpawn.calls.length, 0);
      });
    });
  });
});

test('8c. a directory target is refused before any spawn (regular-file-only)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await mkdir(join(ws, 'a-directory'));
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'a-directory' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const driver = createProofPathDriver({ storageRoot: dir, authorizedExecutionRoot: ws, verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, false);
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

test('8d. a nonexistent target is refused before any spawn', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const review = buildGitAddReviewResult({ packetId: uniqueId(), target: 'does-not-exist.txt' });
      const proposalId = review.proposal.id;
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const verifier = createStaticHumanTurnTokenVerifier({ proposalId, decision: 'AUTHORIZE', expectedToken: TOKEN });
      const driver = createProofPathDriver({ storageRoot: dir, authorizedExecutionRoot: ws, verifyHumanTurnAuthorization: verifier, executionSpawnImpl: executionSpawn });
      const res = await driver.runProofPath({ reviewResult: review, decision: decisionFor(proposalId) });
      assert.equal(res.ok, false);
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

// ═══════════════════ bounded shape: no extra args, no multi-path ════════════

test('8e. selectWitnessProfile rejects an argv with MORE than one path after the prefix', async () => {
  const { selectWitnessProfile } = await import('../persistence/execution-witness.js');
  const plan = { execution_class: 'git-write-local', executable: 'git', argv: ['add', '--', 'file-a.txt', 'file-b.txt'] };
  const res = selectWitnessProfile(plan);
  assert.equal(res.ok, false, 'multi-path staging must never resolve to a witness profile');
});

test('8f. selectWitnessProfile rejects a bare ["add"] with no "--" separator', async () => {
  const { selectWitnessProfile } = await import('../persistence/execution-witness.js');
  const plan = { execution_class: 'git-write-local', executable: 'git', argv: ['add', 'file.txt'] };
  const res = selectWitnessProfile(plan);
  assert.equal(res.ok, false);
});

// ═══════════════ 9. existing git-read / inspect behavior is byte-identical ══

test('9. existing git-read and inspect plans still resolve via the ORIGINAL exact-match branch, unchanged', async () => {
  const { selectWitnessProfile, WITNESS_PROFILES } = await import('../persistence/execution-witness.js');
  const gitReadPlan = { execution_class: 'git-read', executable: 'git', argv: ['status', '--short'] };
  const inspectPlan = { execution_class: 'inspect', executable: 'ls', argv: [] };
  const r1 = selectWitnessProfile(gitReadPlan);
  const r2 = selectWitnessProfile(inspectPlan);
  assert.equal(r1.ok, true);
  assert.equal(r1.profile.profile_id, 'git-status-short.witness.v1');
  assert.equal(r2.ok, true);
  assert.equal(r2.profile.profile_id, 'directory-list.witness.v1');
  assert.equal(Object.keys(WITNESS_PROFILES).length, 3, 'exactly one new profile added — git-read and inspect profiles untouched');
});

// ═══════════════ 10. containment law ═════════════════════════════════════════

test('10a. proposal-execution.js source contains no other git subcommand and no queue/orchestrator/runtime import', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../persistence/proposal-execution.js', import.meta.url), 'utf8');
  const importLines = source.split('\n').filter((l) => /^\s*import\b/.test(l));
  for (const line of importLines) {
    assert.ok(!line.includes('queue-store'), `forbidden import: ${line.trim()}`);
    assert.ok(!line.includes('orchestrator'), `forbidden import: ${line.trim()}`);
    assert.ok(!/runtime\//.test(line), `forbidden runtime/* import: ${line.trim()}`);
  }
  // Only 'add' may appear as a literal argv token destined for git; no commit/push/reset/checkout/etc.
  const forbiddenSubcommands = ['commit', 'push', 'reset', 'checkout', 'switch', 'merge', 'rebase', 'clean'];
  for (const sub of forbiddenSubcommands) {
    assert.ok(!source.includes(`'${sub}'`) && !source.includes(`"${sub}"`), `forbidden git subcommand literal found in source: ${sub}`);
  }
});

test('10b. no OPERATION_REGISTRY entry besides git-add::git-write-local was added', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../persistence/proposal-execution.js', import.meta.url), 'utf8');
  const keys = [...source.matchAll(/'([a-z-]+::[a-z-]+)':/g)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), ['git-add::git-write-local', 'git-read::git-read', 'inspect::inspect'].sort());
});

// ═══════════════ 11. pre-spawn revalidation closes the TOCTOU window ════════
// The initial resolveGitAddTarget() check runs early, while the plan is
// derived. Several durable-write awaits (exclusive claim, EXECUTION_STARTED)
// sit between that check and the real spawn. Each test below lets that first
// check succeed normally, then mutates the filesystem via the injected
// `now()` seam — which fires exactly once, at plan.created_at, squarely
// inside that window — and proves the LATE revalidation catches it before
// any process spawns and before EXECUTION_STARTED is ever recorded.

test('11a. target replaced by a symlink after initial validation but before spawn is refused', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      await writeFile(join(ws, 'elsewhere.txt'), 'other\n');
      const proposalId = await authorizeGitAddProposal(dir, 'file.txt');
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const swap = () => {
        unlinkSync(join(ws, 'file.txt'));
        symlinkSync(join(ws, 'elsewhere.txt'), join(ws, 'file.txt'));
      };
      const executor = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: executionSpawn, now: onceThenNow(swap) });
      const executed = await executor.executeAuthorizedProposal({ storageRoot: dir, proposalId });
      assert.equal(executed.ok, false);
      assert.equal(executed.error, 'EXECUTION_PRESPAWN_REVALIDATION_FAILED');
      assert.equal(executionSpawn.calls.length, 0, 'no process may spawn once the sealed target fails pre-spawn revalidation');
    });
  });
});

test('11b. target replaced by a directory after initial validation but before spawn is refused', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const proposalId = await authorizeGitAddProposal(dir, 'file.txt');
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const swap = () => {
        unlinkSync(join(ws, 'file.txt'));
        mkdirSync(join(ws, 'file.txt'));
      };
      const executor = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: executionSpawn, now: onceThenNow(swap) });
      const executed = await executor.executeAuthorizedProposal({ storageRoot: dir, proposalId });
      assert.equal(executed.ok, false);
      assert.equal(executed.error, 'EXECUTION_PRESPAWN_REVALIDATION_FAILED');
      assert.equal(executionSpawn.calls.length, 0);
    });
  });
});

test('11c. target removed after initial validation but before spawn is refused, and EXECUTION_STARTED is never recorded', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const proposalId = await authorizeGitAddProposal(dir, 'file.txt');
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const swap = () => { unlinkSync(join(ws, 'file.txt')); };
      const executor = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: executionSpawn, now: onceThenNow(swap) });
      const executed = await executor.executeAuthorizedProposal({ storageRoot: dir, proposalId });
      assert.equal(executed.ok, false);
      assert.equal(executed.error, 'EXECUTION_PRESPAWN_REVALIDATION_FAILED');
      assert.equal(executionSpawn.calls.length, 0);
      const reread = await getPendingProposal(dir, proposalId);
      assert.equal(reread.record.state, 'AUTHORIZED_PENDING_EXECUTION', 'a pre-spawn refusal must never advance the proposal into EXECUTION_STARTED');
      assert.equal(reread.record.execution, undefined, 'no execution block may exist on a proposal that never reached the started boundary');
    });
  });
});

test('11d. target redirected through a parent-directory symlink escape before spawn is refused', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await withTempWorkspace(async (outside) => {
        await mkdir(join(ws, 'subdir'));
        await writeFile(join(ws, 'subdir', 'file.txt'), 'inside\n');
        await writeFile(join(outside, 'file.txt'), 'outside\n');
        const proposalId = await authorizeGitAddProposal(dir, join('subdir', 'file.txt'));
        const executionSpawn = makeSpawnRecorder(gitAddSuccess);
        const swap = () => {
          rmSync(join(ws, 'subdir'), { recursive: true, force: true });
          symlinkSync(outside, join(ws, 'subdir'));
        };
        const executor = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: executionSpawn, now: onceThenNow(swap) });
        const executed = await executor.executeAuthorizedProposal({ storageRoot: dir, proposalId });
        assert.equal(executed.ok, false);
        assert.equal(executed.error, 'EXECUTION_PRESPAWN_REVALIDATION_FAILED');
        assert.equal(executionSpawn.calls.length, 0);
      });
    });
  });
});

test('11e. an ordinary authorized git-add still succeeds under the injected now() seam when nothing is swapped', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      await writeFile(join(ws, 'file.txt'), 'hello\n');
      const proposalId = await authorizeGitAddProposal(dir, 'file.txt');
      const executionSpawn = makeSpawnRecorder(gitAddSuccess);
      const executor = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: executionSpawn, now: onceThenNow(() => {}) });
      const executed = await executor.executeAuthorizedProposal({ storageRoot: dir, proposalId });
      assert.equal(executed.ok, true, executed.message);
      assert.deepEqual(executed.plan.argv, ['add', '--', 'file.txt']);
      assert.equal(executionSpawn.calls.length, 1);
    });
  });
});
