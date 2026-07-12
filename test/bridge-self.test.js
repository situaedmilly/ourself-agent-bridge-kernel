// test/bridge-self.test.js
// ── T-034: BridgeSELF routing — admission without authority, without workers ─
// Uses the real sealed T-030→T-033 chain in isolated temp storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { persistPendingProposal } from '../persistence/pending-proposals.js';
import { createStaticHumanTurnTokenVerifier, createHumanTurnDecisionService, DECISION_VERSION } from '../persistence/human-turn-decisions.js';
import { createBoundedProposalExecutor } from '../persistence/proposal-execution.js';
import { createExecutionWitnessService, recordSemanticReconciliation } from '../persistence/semantic-reconciliation.js';
import { createFakeClock, createTimeself } from '../runtime/timeself.js';
import { listQueueItems, getQueueItem, QUEUE_STATES, RETRY_CLASSES } from '../persistence/queue-store.js';
import {
  deriveRouteForRecord, validateRoutedSpec, routeProposalRecord,
  ROUTING_TABLE, BRIDGE_SELF_ERRORS as ERR,
} from '../runtime/bridge-self.js';

const TOKEN = 'human-turn-t034-bridge-test-token';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-bridge-self-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function withTempWorkspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-t034-ws-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeTimeself() {
  return createTimeself(createFakeClock({ startIso: '2026-07-11T00:00:00.000Z' }));
}

function uniqueId(label = 't034') {
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

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.emit('close', null, 'SIGKILL'); return true; };
  return child;
}
function spawnExitZero() {
  return (cmd, args, opts) => {
    const child = fakeChild();
    setImmediate(() => { child.stdout.emit('data', Buffer.from('fake ok\n')); child.emit('close', 0, null); });
    return child;
  };
}

async function chain(dir, ws, { decide = null, execute = false, witness = false, reconcile = false } = {}) {
  const packetId = uniqueId();
  const persisted = await persistPendingProposal(dir, buildReviewResult(packetId));
  assert.equal(persisted.ok, true);
  if (decide) {
    const verifier = createStaticHumanTurnTokenVerifier({ proposalId: packetId, decision: decide, expectedToken: TOKEN });
    const service = createHumanTurnDecisionService({ verifyHumanTurnAuthorization: verifier });
    const record = persisted.record;
    const res = await service.recordHumanTurnDecision({
      storageRoot: dir, proposalId: packetId, presentedToken: TOKEN,
      decisionInput: {
        decision_version: DECISION_VERSION, decision_id: uniqueId('decision'), proposal_id: packetId,
        decision: decide, decided_by: 'MYSELF', decided_at: '2026-07-11T00:05:00.000Z',
        proposal_integrity: { record_hash: record.integrity.record_hash, semantic_checksum: record.semantic_checksum, latest_event_hash: record.events[record.events.length - 1].event_hash },
        reason: 'Authorize isolated T-034 proof only.', constraints: [],
      },
    });
    assert.equal(res.ok, true, res.error || '');
  }
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
  if (reconcile) {
    const res = await recordSemanticReconciliation({ storageRoot: dir, proposalId: packetId });
    assert.equal(res.ok, true, res.message || '');
  }
  return packetId;
}

// ═════════════ Routing law (46-57) ═══════════════════════════════════════════

test('46. an authorized proposal routes to the execution queue but is never consumed', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const timeself = fakeTimeself();
      const proposalId = await chain(dir, ws, { decide: 'AUTHORIZE' });
      const routed = await routeProposalRecord(dir, timeself, { proposalId });
      assert.equal(routed.ok, true, routed.message);
      assert.equal(routed.queue_name, 'execution');
      assert.equal(routed.item.retry_class, RETRY_CLASSES.HUMAN_REQUIRED);
      assert.equal(routed.item.intended_consumer_self, 'HUMAN-TURN', 'display-only: no machine consumer');
      assert.equal(routed.item.state, QUEUE_STATES.QUEUED, 'queued, not leased, not executed');
      assert.equal(routed.item.authority_state, 'AUTHORIZED');
    });
  });
});

test('47-49. the post-execution causal chain routes to witness → reconciliation → memory-update', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const timeself = fakeTimeself();
      const executedOnly = await chain(dir, ws, { decide: 'AUTHORIZE', execute: true });
      const r1 = await routeProposalRecord(dir, timeself, { proposalId: executedOnly });
      assert.equal(r1.queue_name, 'witness');
      assert.equal(r1.item_type, 'execution-terminal-without-witness');

      const witnessed = await chain(dir, ws, { decide: 'AUTHORIZE', execute: true, witness: true });
      const r2 = await routeProposalRecord(dir, timeself, { proposalId: witnessed });
      assert.equal(r2.queue_name, 'reconciliation');
      assert.equal(r2.item_type, 'witness-without-reconciliation');

      const reconciled = await chain(dir, ws, { decide: 'AUTHORIZE', execute: true, witness: true, reconcile: true });
      const r3 = await routeProposalRecord(dir, timeself, { proposalId: reconciled });
      assert.equal(r3.queue_name, 'memory-update');
      assert.equal(r3.item_type, 'reconciled-causal-unit');
    });
  });
});

test('50. a rejected proposal never routes — above all never to execution', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const timeself = fakeTimeself();
      const proposalId = await chain(dir, ws, { decide: 'REJECT' });
      const routed = await routeProposalRecord(dir, timeself, { proposalId });
      assert.equal(routed.ok, true);
      assert.equal(routed.routed, false);
      assert.equal(routed.reason, 'rejected-final-never-routes');
      const execQueue = await listQueueItems(dir, 'execution');
      assert.equal(execQueue.items.length, 0);
    });
  });
});

test('51. corrupted authority never routes', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const timeself = fakeTimeself();
      const proposalId = await chain(dir, ws, { decide: 'AUTHORIZE' });
      const path = join(dir, 'proposals', `${proposalId}.json`);
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.authority.decision = 'REJECT'; // record hash now stale
      await writeFile(path, JSON.stringify(record, null, 2));
      const routed = await routeProposalRecord(dir, timeself, { proposalId });
      assert.equal(routed.ok, false);
      assert.equal(routed.error, ERR.ROUTING_INTEGRITY_FAILURE);
      assert.equal((await listQueueItems(dir, 'execution')).items.length, 0);
    });
  });
});

test('52-54. unsupported type, wrong parent event, and wrong consumer fail closed', () => {
  // 52: unsupported type.
  const unknown = validateRoutedSpec({ item_type: 'exfiltrate-everything', queue_name: 'execution', intended_consumer_self: 'x', retry_class: 'SAFE_AUTOMATIC' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, ERR.UNSUPPORTED_ITEM_TYPE);
  // 53: wrong parent event — an authorized route requires PROPOSAL_AUTHORIZED as last event.
  const derived = deriveRouteForRecord({
    state: 'AUTHORIZED_PENDING_EXECUTION',
    authority: { decision_state: 'AUTHORIZED' },
    events: [{ type: 'PROPOSAL_PERSISTED', event_hash: 'x' }],
  });
  assert.equal(derived.ok, false);
  assert.equal(derived.error, ERR.ROUTING_PARENT_EVENT_MISMATCH);
  // 54: wrong consumer.
  const wrongConsumer = validateRoutedSpec({ item_type: 'witness-without-reconciliation', queue_name: 'reconciliation', intended_consumer_self: 'execution-worker', retry_class: 'SAFE_AUTOMATIC' });
  assert.equal(wrongConsumer.ok, false);
  assert.equal(wrongConsumer.error, ERR.ROUTING_CONSUMER_MISMATCH);
  // Wrong queue for a known type.
  const wrongQueue = validateRoutedSpec({ item_type: 'witness-without-reconciliation', queue_name: 'execution', intended_consumer_self: 'reconciliation-worker', retry_class: 'SAFE_AUTOMATIC' });
  assert.equal(wrongQueue.ok, false);
});

test('55. the correlation ID is the proposal id and survives into the queue item', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const timeself = fakeTimeself();
      const proposalId = await chain(dir, ws, { decide: 'AUTHORIZE', execute: true });
      const routed = await routeProposalRecord(dir, timeself, { proposalId });
      assert.equal(routed.item.correlation_id, proposalId);
      const fetched = await getQueueItem(dir, 'witness', routed.item.queue_item_id);
      assert.equal(fetched.item.correlation_id, proposalId);
      assert.equal(fetched.item.parent_event_hash.length, 64, 'parent event hash bound');
    });
  });
});

test('56-57. routing creates no authority and invokes no worker; repeat routing is idempotent', async () => {
  await withTempStore(async (dir) => {
    await withTempWorkspace(async (ws) => {
      const timeself = fakeTimeself();
      const proposalId = await chain(dir, ws, { decide: 'AUTHORIZE', execute: true });
      const before = JSON.parse(await readFile(join(dir, 'proposals', `${proposalId}.json`), 'utf8'));
      const routed = await routeProposalRecord(dir, timeself, { proposalId });
      assert.equal(routed.ok, true);
      const after = JSON.parse(await readFile(join(dir, 'proposals', `${proposalId}.json`), 'utf8'));
      assert.deepEqual(after, before, 'the proposal record — authority included — is untouched by routing');
      assert.equal(after.witness ?? null, null, 'no worker ran: no witness appeared');
      const again = await routeProposalRecord(dir, timeself, { proposalId });
      assert.equal(again.idempotent, true, 'repeat routing enqueues no duplicate');
      // The routing table itself is frozen law.
      assert.equal(Object.isFrozen(ROUTING_TABLE), true);
    });
  });
});
