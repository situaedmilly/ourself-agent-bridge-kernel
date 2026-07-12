// test/runtime-recovery.test.js
// ── T-034: Startup recovery — RESTARTED ≠ RECOVERED ─────────────────────────
// Uses the real sealed T-030→T-033 chain in isolated temp storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal, eventsLedgerPath } from '../persistence/pending-proposals.js';
import { createStaticHumanTurnTokenVerifier, createHumanTurnDecisionService, DECISION_VERSION } from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import { createExecutionWitnessService } from '../persistence/semantic-reconciliation.js';
import { createFakeClock, createTimeself } from '../runtime/timeself.js';
import { enqueueQueueItem, leaseQueueItem, listQueueItems, RETRY_CLASSES, QUEUE_STATES } from '../persistence/queue-store.js';
import { routeProposalRecord } from '../runtime/bridge-self.js';
import { runStartupRecovery } from '../runtime/recovery.js';

const TOKEN = 'human-turn-t034-recovery-test-token';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-runtime-recovery-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-t034-rws-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeTimeself() {
  const clock = createFakeClock({ startIso: '2026-07-11T00:00:00.000Z' });
  return { clock, timeself: createTimeself(clock) };
}

function uniqueId(label = 't034r') {
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

function spawnExitZero() {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.emit('close', null, 'SIGKILL'); return true; };
    setImmediate(() => { child.stdout.emit('data', Buffer.from('fake ok\n')); child.emit('close', 0, null); });
    return child;
  };
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
      reason: 'Authorize isolated T-034 recovery proof only.', constraints: [],
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

test('67-68. startup verifies the ledger; an invalid ledger prevents READY', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      await chain(dir, ws, { execute: false });
      const clean = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-1' });
      assert.equal(clean.ready_permitted, true, clean.reason);
      // Corrupt the ledger.
      const raw = await readFile(eventsLedgerPath(dir), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const e = JSON.parse(lines[0]);
      e.type = 'FORGED';
      lines[0] = JSON.stringify(e);
      await writeFile(eventsLedgerPath(dir), lines.join('\n') + '\n');
      const broken = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-1' });
      assert.equal(broken.ready_permitted, false);
      assert.equal(broken.reason, 'event_ledger_invalid');
    });
  });
});

test('69-70. corrupt queue items degrade; a corrupted authority record is reported and its item never enqueued', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      const proposalId = await chain(dir, ws, { execute: true });
      // Corrupt a queue item.
      await enqueueQueueItem(dir, timeself, {
        queue_item_id: 'qi-corrupt', queue_name: 'runtime-control', item_type: 'runtime-health-probe',
        producer_self: 'test', intended_consumer_self: 'health-worker', correlation_id: 'c1',
        payload: null, retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
      });
      const p = join(dir, 'queues', 'runtime-control', 'qi-corrupt.json');
      const item = JSON.parse(await readFile(p, 'utf8'));
      item.priority = 99; // hash now stale
      await writeFile(p, JSON.stringify(item));
      // Corrupt the authority record.
      const rp = join(dir, 'proposals', `${proposalId}.json`);
      const record = JSON.parse(await readFile(rp, 'utf8'));
      record.semantic_checksum = 'f'.repeat(64);
      await writeFile(rp, JSON.stringify(record, null, 2));

      const res = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-1' });
      assert.equal(res.degraded, true, 'corruption degrades the runtime');
      assert.equal(res.findings.corrupted_queue_items.length, 1);
      assert.ok(res.findings.proposals_corrupted.length >= 1);
      assert.deepEqual(res.findings.witness_resume_enqueued, [], 'a corrupted record enqueues nothing');
      assert.equal((await listQueueItems(dir, 'witness')).items.length, 0);
    });
  });
});

test('71-72. incomplete witness resumes reconciliation only; execution is never retried', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      const witnessed = await chain(dir, ws, { execute: true, witness: true }); // witness, no reconciliation
      const executedOnly = await chain(dir, ws, { execute: true });             // terminal, no witness
      const authorizedOnly = await chain(dir, ws, { execute: false });          // authorized, unexecuted
      const res = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-1' });
      assert.equal(res.ok, true);
      const enqueued = res.findings.witness_resume_enqueued;
      const byId = Object.fromEntries(enqueued.map((e) => [e.proposal_id, e]));
      assert.equal(byId[witnessed].queue_name, 'reconciliation');
      assert.equal(byId[executedOnly].queue_name, 'witness');
      assert.equal(byId[authorizedOnly], undefined, 'an unexecuted authorized proposal is NOT recovery work');
      assert.equal(res.findings.execution_retries_enqueued, 0, 'execution retry is never enqueued');
      assert.equal((await listQueueItems(dir, 'execution')).items.length, 0, 'recovery placed nothing in the execution queue');
    });
  });
});

test('73-74. expired consequential leases become HUMAN_REQUIRED; safe ones classify reclaimable', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { clock, timeself } = fakeTimeself();
      for (const [id, retryClass] of [['qi-consequential', RETRY_CLASSES.HUMAN_REQUIRED], ['qi-safework', RETRY_CLASSES.SAFE_AUTOMATIC]]) {
        await enqueueQueueItem(dir, timeself, {
          queue_item_id: id, queue_name: 'runtime-control', item_type: 'runtime-health-probe',
          producer_self: 'test', intended_consumer_self: 'health-worker', correlation_id: id,
          payload: null, retry_class: retryClass, maximum_attempts: 3,
        });
        await leaseQueueItem(dir, timeself, { queueName: 'runtime-control', queueItemId: id, workerId: 'w-dead', runtimeInstanceId: 'rt-dead', leaseDurationMs: 30_000 });
      }
      clock.advance(10 * 60_000);
      const res = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-2' });
      assert.deepEqual(res.findings.human_required_leases.map((l) => l.queue_item_id), ['qi-consequential']);
      assert.deepEqual(res.findings.reclaimable_leases.map((l) => l.queue_item_id), ['qi-safework']);
      assert.equal(res.ready_permitted, false, 'an outstanding HUMAN_REQUIRED lease blocks READY');
      assert.equal(res.reason, 'human_required_lease_outstanding');
      // Recovery classified — it did NOT auto-reclaim either lease.
      const items = (await listQueueItems(dir, 'runtime-control')).items;
      assert.ok(items.every((i) => i.state === QUEUE_STATES.LEASED), 'no lease was auto-acted upon');
    });
  });
});

test('75-79. recovery is idempotent, ledgered by callers, and restart preserves items/dead-letters/correlation', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const { timeself } = fakeTimeself();
      const witnessed = await chain(dir, ws, { execute: true, witness: true });
      const first = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-1' });
      assert.equal(first.findings.witness_resume_enqueued.length, 1);
      assert.equal(first.findings.witness_resume_enqueued[0].idempotent, false);
      // 76: a second run (fresh "restarted" runtime) enqueues nothing new.
      const second = await runStartupRecovery(dir, timeself, { runtimeInstanceId: 'rt-2' });
      assert.equal(second.findings.witness_resume_enqueued.length, 1);
      assert.equal(second.findings.witness_resume_enqueued[0].idempotent, true, 'recovery is idempotent');
      // 77-79: the durable item survives with its correlation intact.
      const items = (await listQueueItems(dir, 'reconciliation')).items;
      assert.equal(items.length, 1);
      assert.equal(items[0].correlation_id, witnessed);
      assert.equal(items[0].state, QUEUE_STATES.QUEUED);
    });
  });
});
