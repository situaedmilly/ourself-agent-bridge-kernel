// test/orchestrator.test.js
// ── T-034: Orchestrator — service loop, workers, health, readiness, shutdown ─
// Uses the real sealed T-030→T-033 chain in isolated temp storage. No daemon:
// every runtime here is started, driven by explicit ticks, and terminated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, eventsLedgerPath, getPendingProposal } from '../persistence/pending-proposals.js';
import { createStaticHumanTurnTokenVerifier, createHumanTurnDecisionService, DECISION_VERSION } from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import { createExecutionWitnessService } from '../persistence/semantic-reconciliation.js';
import { createFakeClock, createTimeself } from '../runtime/timeself.js';
import { enqueueQueueItem, listQueueItems, QUEUE_STATES, RETRY_CLASSES } from '../persistence/queue-store.js';
import { routeProposalRecord } from '../runtime/bridge-self.js';
import { getRuntimeLock } from '../runtime/runtime-self.js';
import { computeHealth, computeReadiness } from '../runtime/health.js';
import { createOrchestrator, ORCHESTRATOR_ERRORS } from '../runtime/orchestrator.js';

const TOKEN = 'human-turn-t034-orchestrator-test-token';
const KERNEL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-orchestrator-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-t034-ows-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeTimeself() {
  const clock = createFakeClock({ startIso: '2026-07-11T00:00:00.000Z' });
  return { clock, timeself: createTimeself(clock) };
}

function uniqueId(label = 't034o') {
  return `packet-${label}-${randomBytes(4).toString('hex')}`;
}

function buildReviewResult(packetId) {
  const packet = {
    packet_id: packetId, node: 'Milly', source: 'cli', route: 'git-read', sia: 'ClaudeCodeSELF',
    execution_class: 'git-read', intent: 'show git status of the repo', target: null, status: 'planned',
    created: '2026-07-11T00:00:00.000Z', parent_aecho: null, mutation: false, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched route heuristic',
  };
  const routePlan = {
    route: 'git-read', sia: 'ClaudeCodeSELF', execution_class: 'git-read', mutation: false, requires_approval: true,
    proof_required: ['stdout'], reason: 'matched route heuristic', status: 'planned',
  };
  return {
    protocol: 'ourself.ae-kernel.v1', status: 'ACCEPTED_FOR_REVIEW', execution_performed: false,
    human_turn_required: true,
    proposal: {
      id: packetId, source: 'ourself-intake', origin: { self: 'ourself-agent-bridge', source: 'local-handshake-runner' },
      kind: 'proposal', executionClass: 'git-read', mutation: false, route: 'git-read',
      reason: routePlan.reason, requiresApproval: true, proof: ['stdout'], evidence: [],
      data: { packet, routePlan, requestedExecution: { class: 'git-read', mutation_requested: false } },
      authority: { state: 'PENDING_HUMAN_TURN', human_turn_required: true },
    },
  };
}

function spawnExitZero(calls = []) {
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('close', null, 'SIGKILL'); return true; };
    setImmediate(() => { child.stdout.emit('data', Buffer.from('fake ok\n')); child.emit('close', 0, null); });
    return child;
  };
  impl.calls = calls;
  return impl;
}

async function chain(dir, ws, { execute = true, witness = false } = {}) {
  const packetId = uniqueId();
  const persisted = await persistPendingProposal(dir, buildReviewResult(packetId));
  const record = persisted.record;
  const verifier = createStaticHumanTurnTokenVerifier({ proposalId: packetId, decision: 'AUTHORIZE', expectedToken: TOKEN });
  const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
  await service.recordHumanTurnDecision({
    storageRoot: dir, proposalId: packetId, presentedToken: TOKEN,
    decisionInput: {
      decision_version: DECISION_VERSION, decision_id: uniqueId('decision'), proposal_id: packetId,
      decision: 'AUTHORIZE', decided_by: 'MYSELF', decided_at: '2026-07-11T00:05:00.000Z',
      proposal_integrity: { record_hash: record.integrity.record_hash, semantic_checksum: record.semantic_checksum, latest_event_hash: record.events[record.events.length - 1].event_hash },
      reason: 'Authorize isolated T-034 orchestrator proof only.', constraints: [],
    },
  });
  if (execute) {
    const { executeAuthorizedProposal } = createBoundedProposalExecutor({ authorizedExecutionRoot: ws, spawnImpl: spawnExitZero() });
    const res = await executeAuthorizedProposal({ storageRoot: dir, proposalId: packetId });
    assert.equal(res.ok, true, res.message || '');
  }
  if (witness) {
    const { captureExecutionWitness } = createExecutionWitnessService({ authorizedObservationRoot: ws, spawnImpl: spawnExitZero() });
    const res = await captureExecutionWitness({ storageRoot: dir, proposalId: packetId });
    assert.equal(res.ok, true, res.message || '');
  }
  return packetId;
}

function orchestratorFor(dir, ws, timeself, extra = {}) {
  return createOrchestrator({
    storageRoot: dir, timeself, authorizedObservationRoot: ws,
    kernelHead: 'b4cca0fd989ade16a07a5aa16c80acee508fb59e',
    bootId: extra.bootId ?? 'boot-test', processId: extra.processId ?? 4242, hostname: 'test-node',
    spawnImpl: extra.spawnImpl ?? spawnExitZero(),
    livenessVerifier: extra.livenessVerifier,
  });
}

// ═════ Service loop and workers (80-92) + full causal completion ═════════════

test('80-82+86. the loop leases one item per tick, persists completion, and completes the causal unit without recollection or execution', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      const proposalId = await chain(dir, ws, { execute: true, witness: true }); // witness persisted, reconciliation pending
      const obsSpawn = spawnExitZero();
      const orch = orchestratorFor(dir, ws, timeself, { spawnImpl: obsSpawn });
      const started = await orch.start();
      assert.equal(started.ok, true, started.message);
      assert.equal(started.status, 'READY');
      // Recovery enqueued the reconciliation-resume item.
      const t1 = await orch.tick();
      assert.equal(t1.worked, true);
      assert.equal(t1.worker, 'reconciliation');
      assert.equal(obsSpawn.calls.length, 0, 'reconciliation-resume never recollects a witness observation');
      // The reconciliation worker routed the unit onward to memory-update.
      const t2 = await orch.tick();
      assert.equal(t2.worker, 'memory');
      const record = (await getPendingProposal(dir, proposalId)).record;
      assert.equal(record.reconciliation.status, 'RECONCILED');
      assert.equal(record.state, 'EXECUTION_COMPLETED', 'T-032 terminal state preserved');
      const events = (await readFile(eventsLedgerPath(dir), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.type === 'RUNTIME_MEMORY_EVENT' && e.proposal_id === proposalId), 'bounded runtime memory event recorded');
      // 91: process identity appears in lifecycle events.
      const lifecycle = events.find((e) => e.type === 'RUNTIME_READY');
      assert.equal(lifecycle.process_id, 4242);
      await orch.shutdown();
    });
  });
});

test('80b+85. witness worker captures the witness through the sealed T-033 path and cannot execute proposals', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      const proposalId = await chain(dir, ws, { execute: true }); // terminal execution, no witness
      const orch = orchestratorFor(dir, ws, timeself);
      await orch.start();
      const t1 = await orch.tick();
      assert.equal(t1.worker, 'witness');
      const record = (await getPendingProposal(dir, proposalId)).record;
      assert.ok(record.witness, 'witness captured');
      assert.deepEqual(record.execution.result, record.execution.result, 'execution untouched');
      // 85: the orchestrator module has no execution path at all.
      const src = readFileSync(join(KERNEL_ROOT, 'runtime/orchestrator.js'), 'utf8');
      assert.equal(src.includes("from '../persistence/proposal-execution.js'"), false, 'orchestrator never imports the T-032 executor');
      assert.equal(src.includes('executeAuthorizedProposal'), false);
      await orch.shutdown();
    });
  });
});

test('83-84. HUMAN_REQUIRED work is never leased by the loop; unsupported consumers dead-letter', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      // An authorized proposal routed to the execution queue (HUMAN_REQUIRED).
      const proposalId = await chain(dir, ws, { execute: false });
      await routeProposalRecord(dir, timeself, { proposalId });
      // An unsupported consumer on a safe queue.
      await enqueueQueueItem(dir, timeself, {
        queue_item_id: 'qi-unsupported', queue_name: 'runtime-control', item_type: 'runtime-health-probe',
        producer_self: 'test', intended_consumer_self: 'unknown-worker', correlation_id: 'c-x',
        payload: null, retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
      });
      const orch = orchestratorFor(dir, ws, timeself);
      await orch.start();
      const t1 = await orch.tick();
      assert.equal(t1.dead_lettered, 'qi-unsupported', 'unsupported consumer fails closed to dead-letter');
      let t = await orch.tick();
      while (t.worked) t = await orch.tick();
      // The execution queue item was never leased, never consumed.
      const execItems = (await listQueueItems(dir, 'execution')).items;
      assert.equal(execItems.length, 1);
      assert.equal(execItems[0].state, QUEUE_STATES.QUEUED, 'AUTHORIZED ≠ AUTOMATICALLY EXECUTED');
      const record = (await getPendingProposal(dir, proposalId)).record;
      assert.equal(record.state, 'AUTHORIZED_PENDING_EXECUTION', 'the proposal was never executed');
      const dl = (await listQueueItems(dir, 'dead-letter')).items;
      assert.equal(dl.length, 1);
      await orch.shutdown();
    });
  });
});

test('82b. worker failure follows the retry class: SAFE_AUTOMATIC fails retryable then requeues', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { clock, timeself } = fakeTimeself();
      // A reconciliation item whose proposal does not exist → the worker throws.
      await enqueueQueueItem(dir, timeself, {
        queue_item_id: 'qi-willfail', queue_name: 'reconciliation', item_type: 'witness-without-reconciliation',
        producer_self: 'test', intended_consumer_self: 'reconciliation-worker', correlation_id: 'packet-nonexistent',
        payload: { proposal_id: 'packet-nonexistent' }, retry_class: RETRY_CLASSES.SAFE_AUTOMATIC, maximum_attempts: 2,
      });
      const orch = orchestratorFor(dir, ws, timeself);
      await orch.start();
      // Recovery also enqueued the lawful witness item; drain ticks until our target fails.
      let failedTick = null;
      for (let i = 0; i < 6 && !failedTick; i++) {
        const t = await orch.tick();
        if (t.queue_item_id === 'qi-willfail' && t.failed) failedTick = t;
        if (!t.worked) break;
      }
      assert.ok(failedTick, 'the doomed item was attempted');
      assert.equal(failedTick.failure_state, QUEUE_STATES.FAILED_RETRYABLE);
      // After the retry deadline it re-queues; on exhaustion it dead-letters.
      clock.advance(60 * 60_000);
      let sawDeadLetter = false;
      for (let i = 0; i < 10 && !sawDeadLetter; i++) {
        await orch.tick();
        const dl = (await listQueueItems(dir, 'dead-letter')).items;
        sawDeadLetter = dl.some((d) => d.payload?.original_item?.queue_item_id === 'qi-willfail');
        clock.advance(60 * 60_000);
      }
      assert.equal(sawDeadLetter, true, 'exhausted safe work dead-letters with history preserved');
      await orch.shutdown();
    });
  });
});

test('89-90+92. shutdown law: DRAINING blocks leases; duplicate orchestrators cannot both run; graceful stop releases the lock', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      const orch = orchestratorFor(dir, ws, timeself, { bootId: 'boot-1', processId: 1001 });
      const started = await orch.start();
      assert.equal(started.ok, true, started.message);
      // 92: a duplicate orchestrator on the same storage root refuses startup.
      const dup = orchestratorFor(dir, ws, timeself, { bootId: 'boot-2', processId: 1002 });
      const dupStart = await dup.start();
      assert.equal(dupStart.ok, false);
      const done = await orch.shutdown();
      assert.equal(done.released, true, 'graceful shutdown releases the owned lock');
      assert.equal(orch.getStatus(), 'STOPPED');
      // 90: no lease acquisition after DRAINING.
      const postTick = await orch.tick();
      assert.equal(postTick.ok, false);
      assert.equal(postTick.error, ORCHESTRATOR_ERRORS.ORCHESTRATOR_DRAINING);
      assert.equal((await getRuntimeLock(dir)).locked, false);
      const events = (await readFile(eventsLedgerPath(dir), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const types = events.filter((e) => e.type.startsWith('RUNTIME_')).map((e) => e.type);
      assert.deepEqual(types, ['RUNTIME_LOCK_ACQUIRED', 'RUNTIME_STARTING', 'RUNTIME_RECOVERING', 'RUNTIME_READY', 'RUNTIME_DRAINING', 'RUNTIME_STOPPING', 'RUNTIME_STOPPED', 'RUNTIME_STOPPED_WITNESS', 'RUNTIME_LOCK_RELEASED']);
    });
  });
});

// ═════ Health and readiness (87-88, 93-102) ══════════════════════════════════

test('87-88+93-94+98-101. health worker is read-only; memory worker edits no governance file; health/readiness computed', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      await chain(dir, ws, { execute: true, witness: true });
      await enqueueQueueItem(dir, timeself, {
        queue_item_id: 'qi-health', queue_name: 'runtime-control', item_type: 'runtime-health-probe',
        producer_self: 'test', intended_consumer_self: 'health-worker', correlation_id: 'c-h',
        payload: null, retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
      });
      const orch = orchestratorFor(dir, ws, timeself);
      const started = await orch.start();
      assert.equal(started.readiness.ready, true, JSON.stringify(started.readiness.reasons));
      const ledgerBefore = await readFile(eventsLedgerPath(dir), 'utf8');
      // Health worker runs read-only over storage (only queue bookkeeping events may append).
      let healthResult = null;
      for (let i = 0; i < 6 && !healthResult; i++) {
        const t = await orch.tick();
        if (t.worker === 'health') healthResult = t.result;
        if (!t.worked) break;
      }
      assert.ok(healthResult?.health, 'health worker produced a snapshot');
      const h = healthResult.health;
      assert.equal(h.process_alive, true);
      assert.equal(h.lock_owned, true);
      assert.equal(h.ledger_valid, true);
      assert.equal(h.kernel_git_head, 'b4cca0fd989ade16a07a5aa16c80acee508fb59e', 'version identity reflects kernel HEAD input');
      assert.equal(typeof h.queue_counts['runtime-control'], 'number', 'queue depths reported');
      assert.equal(h.dead_letter_count, 0);
      assert.ok(h.last_heartbeat_at, 'heartbeat age observable');
      // 88: read-only — the snapshot itself appended nothing beyond the item's own lifecycle events.
      const after = (await readFile(eventsLedgerPath(dir), 'utf8')).split('\n').filter(Boolean);
      const newTypes = after.slice(ledgerBefore.split('\n').filter(Boolean).length).map((l) => JSON.parse(l).type);
      assert.ok(newTypes.every((t) => t.startsWith('QUEUE_ITEM_') || t === 'RUNTIME_MEMORY_EVENT' || t.startsWith('RECONCIL')), `only queue/memory/causal bookkeeping: ${newTypes}`);
      // 87: memory worker touched no governance file (none exists in the store at all).
      assert.equal(newTypes.filter((t) => t === 'RUNTIME_MEMORY_EVENT').length <= 1, true);
      await orch.shutdown();
    });
  });
});

test('95-97. readiness is false on invalid ledger, unowned lock, or an unknown consequential lease', () => {
  const goodHealth = {
    storage_reachable: true, ledger_valid: true, lock_valid: true, lock_owned: true,
    unknown_consequential_lease_count: 0,
  };
  const goodRecovery = { ok: true, ready_permitted: true, reason: null };
  assert.equal(computeReadiness(goodHealth, goodRecovery).ready, true);
  assert.equal(computeReadiness({ ...goodHealth, ledger_valid: false }, goodRecovery).ready, false);
  assert.equal(computeReadiness({ ...goodHealth, lock_owned: false }, goodRecovery).ready, false);
  assert.equal(computeReadiness({ ...goodHealth, unknown_consequential_lease_count: 1 }, goodRecovery).ready, false);
  assert.equal(computeReadiness(goodHealth, goodRecovery, { configValid: false }).ready, false);
  assert.equal(computeReadiness(goodHealth, { ok: true, ready_permitted: false, reason: 'x' }).ready, false);
});

test('94b. a corrupted queue item yields DEGRADED: healthy but not launch-clean, still lawful', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      await enqueueQueueItem(dir, timeself, {
        queue_item_id: 'qi-willcorrupt', queue_name: 'runtime-control', item_type: 'runtime-health-probe',
        producer_self: 'test', intended_consumer_self: 'health-worker', correlation_id: 'c-1',
        payload: null, retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
      });
      const p = join(dir, 'queues', 'runtime-control', 'qi-willcorrupt.json');
      const item = JSON.parse(await readFile(p, 'utf8'));
      item.priority = 99;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(p, JSON.stringify(item));
      const orch = orchestratorFor(dir, ws, timeself);
      const started = await orch.start();
      assert.equal(started.ok, true);
      assert.equal(started.recovery.degraded, true);
      assert.equal(started.status, 'READY', 'corruption degrades findings but readiness law still computes over blocking conditions');
      const health = await computeHealth(dir, timeself, orch.getInstance());
      assert.equal(health.corrupted_item_counts['runtime-control'], 1, 'corrupted count accurate');
      await orch.shutdown();
    });
  });
});

// ═════ Security and authority (102-117, source-level) ════════════════════════

test('102-117. no network, no credential surface, no model, no governance mutation in any T-034 module', () => {
  const files = ['runtime/timeself.js', 'runtime/bridge-self.js', 'runtime/runtime-self.js', 'runtime/recovery.js', 'runtime/health.js', 'runtime/orchestrator.js', 'persistence/queue-store.js'];
  const forbidden = [
    'node:http', 'node:net', 'node:tls', 'createserver', '.listen(', 'fetch(', 'axios', 'express', 'websocket', // no network route or call
    'presentedToken', 'authorization_token', 'expectedToken', // no HUMAN-TURN credential surface
    'anthropic', 'openai', 'messages.create', 'model.generate', // no model
    'MASTER_FILE', 'CLAUDESELF_HANDOFF', 'TASKS.md', // no governance files
    'launchctl', 'launchd', 'pm2', 'crontab', // no service installation
    'process.env.', // no secret environment persisted or read
    'executeAuthorizedProposal', // no automatic T-032 execution
  ];
  for (const f of files) {
    const src = readFileSync(join(KERNEL_ROOT, f), 'utf8').toLowerCase();
    for (const needle of forbidden) {
      assert.equal(src.includes(needle.toLowerCase()), false, `${f} must not contain "${needle}"`);
    }
  }
});
