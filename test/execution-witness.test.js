// test/execution-witness.test.js
// ── T-033 (part 1): Execution Witness primitives + durable capture — proofs ─
// Every test uses its own isolated temp storageRoot and temp workspace OUTSIDE
// both live repositories. No fixture from any prior session is reused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, eventsLedgerPath, verifyEventLedger, verifyPendingProposal } from '../persistence/pending-proposals.js';
import { createStaticHumanTurnTokenVerifier, createHumanTurnDecisionService, DECISION_VERSION } from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import {
  WITNESS_PROFILES,
  WITNESS_VERSION,
  NORMALIZATION_VERSION,
  EXECUTION_WITNESS_ERRORS as WERR,
  RECONCILIATION_STATUSES,
  OUTCOME_CLASSES,
  normalizeOutput,
  normalizeFailureClass,
  selectWitnessProfile,
  captureTargetFingerprint,
  runBoundedObservation,
  buildWitnessPacket,
  computeWitnessHash,
  verifyExecutionWitness,
} from '../persistence/execution-witness.js';
import { createExecutionWitnessService } from '../persistence/semantic-reconciliation.js';

const TOKEN = 'human-turn-t033-test-token-do-not-reuse';

// ── Fixtures (same shapes the T-030/T-031/T-032 suites established) ─────────

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-execution-witness-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-t033-workspace-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function uniqueId(label = 't033') {
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

/** Persist + AUTHORIZE + EXECUTE through the real T-030/T-031/T-032 chain. */
async function executedProposal(dir, ws, { executionBehavior = behaviorExitZero, overrides = {} } = {}) {
  const persisted = await persistPendingProposal(dir, buildReviewResult(overrides));
  assert.equal(persisted.ok, true, 'fixture persist must succeed');
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId: persisted.proposal_id, decision: 'AUTHORIZE', expectedToken: TOKEN });
  const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
  const decided = await service.recordHumanTurnDecision({
    storageRoot: dir, proposalId: persisted.proposal_id,
    decisionInput: decisionFor(persisted.record, { decision: 'AUTHORIZE' }), presentedToken: TOKEN,
  });
  assert.equal(decided.ok, true, `fixture authorize must succeed: ${decided.error || ''}`);
  const spawnImpl = makeSpawnRecorder(executionBehavior);
  const { executeAuthorizedProposal } = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl });
  const executed = await executeAuthorizedProposal({ storageRoot: dir, proposalId: persisted.proposal_id });
  assert.equal(executed.ok, true, `fixture execution must succeed: ${executed.message || ''}`);
  return { proposalId: persisted.proposal_id, executed, executionSpawn: spawnImpl };
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

const behaviorExitZero = (child) => {
  child.stdout.emit('data', Buffer.from('fake ok\n'));
  child.emit('close', 0, null);
};
const behaviorNeverExit = () => { /* only the timeout SIGKILL ends it */ };
const behaviorSpawnError = (child) => {
  child.emit('error', new Error('spawn git ENOENT (simulated)'));
};

function witnessServiceFor(ws, opts = {}) {
  return createExecutionWitnessService({ authorizedObservationRoot: ws, ...opts });
}

// ═════════════════════ Normalization and profile law (1-7) ══════════════════

test('1. normalizeOutput: CRLF/CR become LF and trailing blank lines drop, order preserved', () => {
  assert.equal(normalizeOutput('a\r\nb\rc\n\n\n'), 'a\nb\nc');
  assert.equal(normalizeOutput('a\nb'), 'a\nb');
  assert.equal(normalizeOutput(''), '');
  assert.notEqual(normalizeOutput('b\na'), normalizeOutput('a\nb'), 'line order is significant');
});

test('2. normalizeFailureClass: git 128 not-a-repository maps to a stable class', () => {
  const cls = normalizeFailureClass('git-status-short.witness.v1', {
    failure_code: 'EXECUTION_NONZERO_EXIT', exit_code: 128,
    stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
  });
  assert.equal(cls, 'NOT_A_GIT_REPOSITORY');
});

test('3. normalizeFailureClass: generic nonzero exits map to NONZERO_EXIT_<n>; timeout/spawn map to null', () => {
  assert.equal(normalizeFailureClass('directory-list.witness.v1', { failure_code: 'EXECUTION_NONZERO_EXIT', exit_code: 2, stderr: 'x' }), 'NONZERO_EXIT_2');
  assert.equal(normalizeFailureClass('directory-list.witness.v1', { failure_code: 'EXECUTION_TIMEOUT', exit_code: null, stderr: '' }), null);
  assert.equal(normalizeFailureClass('directory-list.witness.v1', { failure_code: 'EXECUTION_SPAWN_FAILED', exit_code: null, stderr: '' }), null);
});

test('4. the witness-profile registry is frozen and holds exactly the three authorized operations', () => {
  assert.equal(Object.isFrozen(WITNESS_PROFILES), true);
  const ids = Object.keys(WITNESS_PROFILES);
  assert.deepEqual(ids.sort(), ['directory-list.witness.v1', 'git-add-status-short.witness.v1', 'git-status-short.witness.v1']);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate profile ids');
  for (const p of Object.values(WITNESS_PROFILES)) {
    assert.equal(Object.isFrozen(p), true);
    assert.equal(Object.isFrozen(p.observation.argv), true);
    assert.equal(p.normalization_version, NORMALIZATION_VERSION);
  }
});

test('5. selectWitnessProfile selects by persisted plan only and fails closed on unknown shapes', () => {
  const gitPlan = { execution_class: 'git-read', executable: 'git', argv: ['status', '--short'] };
  assert.equal(selectWitnessProfile(gitPlan).profile.profile_id, 'git-status-short.witness.v1');
  const lsPlan = { execution_class: 'inspect', executable: 'ls', argv: [] };
  assert.equal(selectWitnessProfile(lsPlan).profile.profile_id, 'directory-list.witness.v1');
  for (const bad of [
    null,
    {},
    { execution_class: 'git-read', executable: 'git', argv: ['status'] },
    { execution_class: 'git-read', executable: 'rm', argv: ['status', '--short'] },
    { execution_class: 'deploy', executable: 'git', argv: ['status', '--short'] },
  ]) {
    const res = selectWitnessProfile(bad);
    assert.equal(res.ok, false);
    assert.equal(res.error, WERR.UNSUPPORTED_WITNESS_PROFILE);
  }
});

test('6. captureTargetFingerprint: valid directory produces a bounded fingerprint', async () => {
  await withTempWorkspace(async (ws) => {
    const real = await (await import('node:fs/promises')).realpath(ws);
    const res = await captureTargetFingerprint({ planCwd: real, authorizedRoot: real });
    assert.equal(res.ok, true, res.message);
    assert.equal(res.fingerprint.is_symlink, false);
    assert.match(res.fingerprint.realpath_hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(res.fingerprint.git_root_present, false);
  });
});

test('7. captureTargetFingerprint fails closed on missing, symlinked, and out-of-root targets', async () => {
  await withTempWorkspace(async (ws) => {
    const real = await (await import('node:fs/promises')).realpath(ws);
    const missing = await captureTargetFingerprint({ planCwd: join(real, 'gone'), authorizedRoot: real });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, WERR.WITNESS_TARGET_FINGERPRINT_MISMATCH);

    await mkdir(join(real, 'inner'));
    await symlink(join(real, 'inner'), join(real, 'link'));
    const linked = await captureTargetFingerprint({ planCwd: join(real, 'link'), authorizedRoot: real });
    assert.equal(linked.ok, false);
    assert.equal(linked.error, WERR.WITNESS_CWD_SYMLINK_VIOLATION);

    const outside = await captureTargetFingerprint({ planCwd: real, authorizedRoot: join(real, 'inner') });
    assert.equal(outside.ok, false);
    assert.equal(outside.error, WERR.WITNESS_CWD_BOUNDARY_VIOLATION);
  });
});

// ═════════════════════ Bounded observation runner (8-11) ════════════════════

test('8. runBoundedObservation: completed observation is captured with no shell and minimal env', async () => {
  const spawnImpl = makeSpawnRecorder(behaviorExitZero);
  const obs = await runBoundedObservation({
    spawnImpl, executable: 'git', argv: ['status', '--short'], cwd: '/anywhere',
    timeoutMs: 1000, maxOutputBytes: 1024, now: () => '2026-07-11T00:10:00.000Z',
  });
  assert.equal(obs.classification, 'completed');
  assert.equal(obs.exit_code, 0);
  assert.equal(obs.stdout, 'fake ok\n');
  assert.equal(obs.stdout_truncated, false);
  const call = spawnImpl.calls[0];
  assert.equal(call.opts.shell, false);
  assert.deepEqual(call.opts.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(call.opts.env).sort(), ['LC_ALL', 'PATH'], 'no inherited environment');
});

test('9. runBoundedObservation: a hung observation is SIGKILLed and classified timeout', async () => {
  const spawnImpl = makeSpawnRecorder(behaviorNeverExit);
  const obs = await runBoundedObservation({
    spawnImpl, executable: 'ls', argv: [], cwd: '/anywhere',
    timeoutMs: 50, maxOutputBytes: 1024, now: () => '2026-07-11T00:10:00.000Z',
  });
  assert.equal(obs.classification, 'timeout');
});

test('10. runBoundedObservation: spawn failure is classified, never thrown', async () => {
  const spawnImpl = makeSpawnRecorder(behaviorSpawnError);
  const obs = await runBoundedObservation({
    spawnImpl, executable: 'git', argv: ['status', '--short'], cwd: '/anywhere',
    timeoutMs: 1000, maxOutputBytes: 1024, now: () => '2026-07-11T00:10:00.000Z',
  });
  assert.equal(obs.classification, 'spawn_failed');
  assert.match(obs.spawn_error, /ENOENT/);
});

test('11. runBoundedObservation: oversized output is truncated with flags set', async () => {
  const spawnImpl = makeSpawnRecorder((child) => {
    child.stdout.emit('data', Buffer.alloc(4096, 0x61));
    child.emit('close', 0, null);
  });
  const obs = await runBoundedObservation({
    spawnImpl, executable: 'ls', argv: [], cwd: '/anywhere',
    timeoutMs: 1000, maxOutputBytes: 100, now: () => '2026-07-11T00:10:00.000Z',
  });
  assert.equal(obs.stdout_truncated, true);
  assert.equal(obs.stdout.length, 100);
});

// ═════════════════════ Witness packet integrity (12-13) ═════════════════════

test('12. buildWitnessPacket binds the observation to the persisted execution and self-hashes', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId, executed } = await executedProposal(dir, ws);
      const profile = WITNESS_PROFILES['git-status-short.witness.v1'];
      const observation = {
        started_at: 'x', completed_at: 'y', duration_ms: 1, classification: 'completed',
        exit_code: 0, signal: null, stdout: 'fake ok\n', stderr: '',
        stdout_truncated: false, stderr_truncated: false, spawn_error: null,
      };
      const fingerprint = { fingerprint_version: 'ourself.target-fingerprint.v1', realpath_hash: 'sha256:0', execution_root_hash: 'sha256:0', device: 1, inode: 2, is_symlink: false, git_root_present: false };
      const packet = buildWitnessPacket({ proposalId, record: executed.record, profile, observation, fingerprint });
      assert.equal(packet.witness_version, WITNESS_VERSION);
      assert.equal(packet.execution_plan_hash, executed.record.execution.plan.plan_hash);
      assert.equal(packet.execution_result_hash, executed.record.execution.result_hash);
      assert.equal(packet.witness_hash, computeWitnessHash(packet));
      const tampered = { ...packet, stdout: 'different' };
      assert.notEqual(computeWitnessHash(tampered), packet.witness_hash, 'tamper changes the hash');
    });
  });
});

test('13. verifyExecutionWitness reports witnessed:false (valid) for an unwitnessed execution', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      const res = await verifyExecutionWitness(dir, proposalId);
      assert.deepEqual(res, { ok: true, valid: true, witnessed: false });
    });
  });
});

// ═════════════════════ Durable witness capture (14-22) ══════════════════════

test('14. captureExecutionWitness: happy path persists witness, event, and valid hashes', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      const obsSpawn = makeSpawnRecorder(behaviorExitZero);
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: obsSpawn });
      const res = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(res.witnessed, true);
      assert.equal(res.witness.witness_profile_id, 'git-status-short.witness.v1');
      assert.equal(obsSpawn.calls.length, 1, 'exactly one observation process');

      const verified = await verifyExecutionWitness(dir, proposalId);
      assert.deepEqual(verified, { ok: true, valid: true, witnessed: true });
      const recordCheck = await verifyPendingProposal(dir, proposalId);
      assert.equal(recordCheck.valid, true, 'record hash rebinds over the witness block');
      const ledgerCheck = await verifyEventLedger(dir);
      assert.equal(ledgerCheck.valid, true, 'ledger chain unbroken after WITNESS_CAPTURED');
      const lastEvent = res.record.events[res.record.events.length - 1];
      assert.equal(lastEvent.type, 'WITNESS_CAPTURED');
      assert.equal(lastEvent.witness_hash, res.witness.witness_hash);
    });
  });
});

test('15. capture request cannot override the witness law (forbidden fields fail closed)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      const obsSpawn = makeSpawnRecorder(behaviorExitZero);
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: obsSpawn });
      for (const field of ['profile', 'executable', 'argv', 'cwd', 'env', 'timeoutMs', 'spawnImpl', 'normalization', 'token', 'presentedToken']) {
        const res = await captureExecutionWitness({ storageRoot: dir, proposalId, [field]: 'x' });
        assert.equal(res.ok, false, `field ${field} must be rejected`);
        assert.equal(res.error, WERR.WITNESS_OVERRIDE_FORBIDDEN);
      }
      assert.equal(obsSpawn.calls.length, 0, 'no observation ran');
    });
  });
});

test('16. a non-terminal proposal cannot be witnessed (persisted and authorized states fail closed)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const persisted = await persistPendingProposal(dir, buildReviewResult());
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await captureExecutionWitness({ storageRoot: dir, proposalId: persisted.proposal_id });
      assert.equal(res.ok, false);
      assert.equal(res.error, WERR.WITNESS_EXECUTION_NOT_TERMINAL);
    });
  });
});

test('17. witness capture is one-shot: a repeat returns the recorded witness without re-observing', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      const obsSpawn = makeSpawnRecorder(behaviorExitZero);
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: obsSpawn });
      const first = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(first.ok, true, first.message);
      const second = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(second.ok, true);
      assert.equal(second.idempotent, true);
      assert.equal(second.code, WERR.WITNESS_ALREADY_CAPTURED);
      assert.equal(second.witness.witness_hash, first.witness.witness_hash);
      assert.equal(obsSpawn.calls.length, 1, 'no second observation process');
    });
  });
});

test('18. a pre-existing witness claim blocks capture (CONCURRENT_WITNESS_CONFLICT, no auto-recovery)', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      await mkdir(join(dir, 'witnesses'), { recursive: true });
      await writeFile(join(dir, 'witnesses', `${proposalId}.lock`), '{"stale":true}\n');
      const obsSpawn = makeSpawnRecorder(behaviorExitZero);
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: obsSpawn });
      const res = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(res.ok, false);
      assert.equal(res.error, WERR.CONCURRENT_WITNESS_CONFLICT);
      assert.equal(obsSpawn.calls.length, 0, 'no observation ran under a foreign claim');
      const raw = await readFile(join(dir, 'witnesses', `${proposalId}.lock`), 'utf8');
      assert.equal(raw, '{"stale":true}\n', 'the module never deletes or repairs a claim');
    });
  });
});

test('19. witness capture never reruns the execution and never mutates the execution result', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId, executed, executionSpawn } = await executedProposal(dir, ws);
      const obsSpawn = makeSpawnRecorder(behaviorExitZero);
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: obsSpawn });
      const res = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.equal(executionSpawn.calls.length, 1, 'the T-032 spawn count is still exactly one');
      assert.deepEqual(res.record.execution.result, executed.record.execution.result, 'execution result untouched');
      assert.equal(res.record.execution.result_hash, executed.record.execution.result_hash);
      assert.equal(res.record.state, executed.record.state, 'T-033 never rewrites record.state');
      assert.deepEqual(res.record.authority, executed.record.authority, 'authority block untouched');
    });
  });
});

test('20. witness observation does not mutate the observed target', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      await writeFile(join(ws, 'sentinel.txt'), 'before\n');
      const listingBefore = (await readdir(ws)).sort();
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const res = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(res.ok, true, res.message);
      assert.deepEqual((await readdir(ws)).sort(), listingBefore, 'workspace contents unchanged');
      assert.equal(await readFile(join(ws, 'sentinel.txt'), 'utf8'), 'before\n');
    });
  });
});

test('21. a tampered persisted witness fails verifyExecutionWitness', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { proposalId } = await executedProposal(dir, ws);
      const { captureExecutionWitness } = witnessServiceFor(ws, { spawnImpl: makeSpawnRecorder(behaviorExitZero) });
      const captured = await captureExecutionWitness({ storageRoot: dir, proposalId });
      assert.equal(captured.ok, true, captured.message);
      const path = join(dir, 'proposals', `${proposalId}.json`);
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.witness.stdout = 'forged observation output';
      await writeFile(path, JSON.stringify(record, null, 2));
      const res = await verifyExecutionWitness(dir, proposalId);
      assert.equal(res.valid, false);
      assert.ok(res.details.includes('witness_hash_mismatch'));
    });
  });
});

test('22. capture fails closed when the observation target no longer matches the plan', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      let proposalId;
      {
        const fixture = await executedProposal(dir, ws);
        proposalId = fixture.proposalId;
      }
      // Swap the planned cwd for a symlink to elsewhere.
      await withTempWorkspace(async (elsewhere) => {
        await rm(ws, { recursive: true, force: true });
        await symlink(elsewhere, ws);
        const { captureExecutionWitness } = createExecutionWitnessService({ authorizedObservationRoot: elsewhere, spawnImpl: makeSpawnRecorder(behaviorExitZero) });
        const res = await captureExecutionWitness({ storageRoot: dir, proposalId });
        assert.equal(res.ok, false);
        assert.ok([WERR.WITNESS_CWD_SYMLINK_VIOLATION, WERR.WITNESS_TARGET_FINGERPRINT_MISMATCH, WERR.WITNESS_CWD_BOUNDARY_VIOLATION].includes(res.error), res.error);
      });
    });
  });
});

// ═════════ Resumption-specific laws (module creation is inert) (23-25) ══════

test('23. importing the T-033 modules creates no filesystem state, no claim, no ledger event', async () => {
  await withTempStore(async (dir) => {
    const persisted = await persistPendingProposal(dir, buildReviewResult());
    assert.equal(persisted.ok, true);
    const hashBefore = persisted.record.integrity.record_hash;
    await import('../persistence/execution-witness.js');
    await import('../persistence/semantic-reconciliation.js');
    const entries = (await readdir(dir)).sort();
    assert.deepEqual(entries, ['events.jsonl', 'proposals'], 'no witnesses/, reconciliations/, or other artifact from import alone');
    const ledgerRaw = await readFile(eventsLedgerPath(dir), 'utf8');
    assert.equal(ledgerRaw.split('\n').filter(Boolean).length, 1, 'only the PROPOSAL_PERSISTED event exists');
    const check = await verifyPendingProposal(dir, persisted.proposal_id);
    assert.equal(check.valid, true);
    const reread = JSON.parse(await readFile(join(dir, 'proposals', `${persisted.proposal_id}.json`), 'utf8'));
    assert.equal(reread.integrity.record_hash, hashBefore, 'no proposal state changed by module presence');
  });
});

test('24. constructing the witness service performs no observation and writes nothing', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const spawnImpl = makeSpawnRecorder(behaviorExitZero);
      witnessServiceFor(ws, { spawnImpl });
      assert.equal(spawnImpl.calls.length, 0);
      assert.deepEqual(await readdir(dir), [], 'store untouched by construction');
    });
  });
});

test('25. trusted construction rejects a non-absolute observation root', () => {
  assert.throws(() => createExecutionWitnessService({ authorizedObservationRoot: 'relative/path' }), TypeError);
  assert.throws(() => createExecutionWitnessService({}), TypeError);
});

// ═════════════════ Contract constants are the sealed T-033 set ══════════════

test('26. reconciliation statuses and outcome classes are exactly the authorized sets', () => {
  assert.deepEqual(Object.values(RECONCILIATION_STATUSES).sort(), ['RECONCILED', 'RECONCILIATION_DIVERGED', 'RECONCILIATION_INDETERMINATE']);
  assert.deepEqual(Object.values(OUTCOME_CLASSES).sort(), ['FAILURE_CONFIRMED', 'SUCCESS_CONFIRMED']);
  assert.equal(Object.isFrozen(RECONCILIATION_STATUSES), true);
  assert.equal(Object.isFrozen(OUTCOME_CLASSES), true);
});
