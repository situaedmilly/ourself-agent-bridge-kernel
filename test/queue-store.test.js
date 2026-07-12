// test/queue-store.test.js
// ── T-034: Durable queue store — integrity, transitions, leases, dead-letter ─
// Every test uses its own isolated temp storageRoot outside both repositories.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { verifyEventLedger, eventsLedgerPath } from '../persistence/pending-proposals.js';
import { createFakeClock, createTimeself } from '../runtime/timeself.js';
import {
  enqueueQueueItem, getQueueItem, listQueueItems,
  leaseQueueItem, renewLease, completeQueueItem, failQueueItem,
  requeueRetryableItem, reclaimExpiredLease, classifyExpiredLease,
  cancelQueueItem, deadLetterQueueItem,
  computeQueueItemHash, verifyQueueItemShape,
  QUEUE_STORE_ERRORS as ERR, QUEUE_STATES, RETRY_CLASSES, QUEUE_NAMES,
} from '../persistence/queue-store.js';

async function withTempStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'ourself-queue-store-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function fakeTimeself() {
  const clock = createFakeClock({ startIso: '2026-07-11T00:00:00.000Z' });
  return { clock, timeself: createTimeself(clock) };
}

function itemInput(overrides = {}) {
  return {
    queue_item_id: overrides.queue_item_id ?? `qi-${randomBytes(4).toString('hex')}`,
    queue_name: 'witness',
    item_type: 'execution-terminal-without-witness',
    producer_self: 'BridgeSELF',
    intended_consumer_self: 'witness-worker',
    correlation_id: 'packet-corr-1',
    payload: { proposal_id: 'packet-corr-1' },
    retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
    maximum_attempts: 3,
    ...overrides,
  };
}

async function leased(dir, timeself, overrides = {}) {
  const enq = await enqueueQueueItem(dir, timeself, itemInput(overrides));
  assert.equal(enq.ok, true, enq.message);
  const res = await leaseQueueItem(dir, timeself, {
    queueName: enq.item.queue_name, queueItemId: enq.item.queue_item_id,
    workerId: 'w1', runtimeInstanceId: 'rt-1', leaseDurationMs: 60_000,
  });
  assert.equal(res.ok, true, res.message);
  return { item: res.item, lease: res.item.lease };
}

// ═════════════ Queue integrity (items 1-15) ═════════════════════════════════

test('1. a valid item enqueues with verified hashes and a ledger event', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const res = await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-valid' }));
    assert.equal(res.ok, true, res.message);
    assert.equal(res.item.state, QUEUE_STATES.QUEUED);
    const shape = verifyQueueItemShape(res.item);
    assert.equal(shape.valid, true, JSON.stringify(shape.details));
    const raw = await readFile(eventsLedgerPath(dir), 'utf8');
    const events = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(events[0].type, 'QUEUE_ITEM_ENQUEUED');
    assert.equal(events[0].queue_item_id, 'qi-valid');
    assert.equal((await verifyEventLedger(dir)).valid, true);
  });
});

test('2-4. malformed item, unsafe queue name, and unsafe item id are rejected', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const missingRetry = await enqueueQueueItem(dir, timeself, itemInput({ retry_class: undefined }));
    assert.equal(missingRetry.ok, false);
    const badQueue = await enqueueQueueItem(dir, timeself, itemInput({ queue_name: 'exfiltration' }));
    assert.equal(badQueue.ok, false);
    assert.equal(badQueue.error, ERR.UNSAFE_QUEUE_NAME);
    const badId = await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'bad/../../id' }));
    assert.equal(badId.ok, false);
    assert.equal(badId.error, ERR.UNSAFE_QUEUE_ITEM_ID);
  });
});

test('5-6. path traversal and symlinked items are refused', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const traversal = await getQueueItem(dir, 'witness', '../../etc/passwd');
    assert.equal(traversal.ok, false);
    // Symlinked item file.
    await mkdir(join(dir, 'queues', 'witness'), { recursive: true });
    await withTempStoreInner(async (other) => {
      await writeFile(join(other, 'target.json'), '{}');
      await symlink(join(other, 'target.json'), join(dir, 'queues', 'witness', 'qi-link.json'));
      const linked = await getQueueItem(dir, 'witness', 'qi-link');
      assert.equal(linked.ok, false);
      assert.equal(linked.error, ERR.QUEUE_BOUNDARY_VIOLATION);
    });
  });
  async function withTempStoreInner(fn) {
    const d = await mkdtemp(join(tmpdir(), 'ourself-queue-symlink-'));
    try { await fn(d); } finally { await rm(d, { recursive: true, force: true }); }
  }
});

test('7-10. tampered payload/item hashes are detected and isolated without hiding healthy items', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-healthy' }));
    const bad = await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-tampered' }));
    const path = join(dir, 'queues', 'witness', 'qi-tampered.json');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    parsed.payload = { proposal_id: 'forged' }; // payload hash now mismatches
    await writeFile(path, JSON.stringify(parsed));
    const got = await getQueueItem(dir, 'witness', 'qi-tampered');
    assert.equal(got.valid, false);
    assert.ok(got.details.includes('payload_hash_mismatch'));
    // item-hash tamper
    const parsed2 = JSON.parse(JSON.stringify(bad.item));
    parsed2.priority = 99;
    assert.notEqual(computeQueueItemHash(parsed2), bad.item.item_hash);
    const listed = await listQueueItems(dir, 'witness');
    assert.deepEqual(listed.items.map((i) => i.queue_item_id), ['qi-healthy'], 'corrupted item does not abort healthy listing');
    assert.equal(listed.corrupted.length, 1);
  });
});

test('11-12. duplicate identical enqueue is idempotent; conflicting duplicate fails closed', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const input = itemInput({ queue_item_id: 'qi-dup' });
    const first = await enqueueQueueItem(dir, timeself, input);
    assert.equal(first.ok, true);
    const repeat = await enqueueQueueItem(dir, timeself, input);
    assert.equal(repeat.idempotent, true);
    assert.equal(repeat.code, ERR.QUEUE_ITEM_ALREADY_ENQUEUED);
    const conflict = await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-dup', payload: { proposal_id: 'different' } }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, ERR.QUEUE_ITEM_IDENTITY_CONFLICT);
  });
});

test('13-15. every transition appends a chained event; tampering and reordering are detected', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const { item, lease } = await leased(dir, timeself, { queue_item_id: 'qi-events' });
    await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-events', workerId: 'w1', leaseId: lease.lease_id });
    const raw = await readFile(eventsLedgerPath(dir), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const types = lines.map((l) => JSON.parse(l).type);
    assert.deepEqual(types, ['QUEUE_ITEM_ENQUEUED', 'QUEUE_ITEM_LEASED', 'QUEUE_ITEM_COMPLETED']);
    assert.equal((await verifyEventLedger(dir)).valid, true);
    // Tamper: edit a field.
    const tampered = [...lines];
    const e = JSON.parse(tampered[1]);
    e.worker_id = 'forged';
    tampered[1] = JSON.stringify(e);
    await writeFile(eventsLedgerPath(dir), tampered.join('\n') + '\n');
    assert.equal((await verifyEventLedger(dir)).valid, false, 'tampering detected');
    // Reorder.
    await writeFile(eventsLedgerPath(dir), [lines[1], lines[0], lines[2]].join('\n') + '\n');
    assert.equal((await verifyEventLedger(dir)).valid, false, 'reordering detected');
    assert.ok(item);
  });
});

// ═════════════ Transitions (16-25) ═══════════════════════════════════════════

test('16-19. QUEUED→LEASED→COMPLETED / FAILED_RETRYABLE / FAILED_FINAL follow the law', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const a = await leased(dir, timeself, { queue_item_id: 'qi-a' });
    assert.equal(a.item.state, QUEUE_STATES.LEASED);
    const done = await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-a', workerId: 'w1', leaseId: a.lease.lease_id });
    assert.equal(done.item.state, QUEUE_STATES.COMPLETED);

    const b = await leased(dir, timeself, { queue_item_id: 'qi-b' });
    const failedRetryable = await failQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-b', workerId: 'w1', leaseId: b.lease.lease_id, errorMessage: 'transient' });
    assert.equal(failedRetryable.item.state, QUEUE_STATES.FAILED_RETRYABLE);
    assert.ok(failedRetryable.item.eligible_at > timeself.now(), 'retry deadline pushed into the future');

    const c = await leased(dir, timeself, { queue_item_id: 'qi-c', retry_class: RETRY_CLASSES.HUMAN_REQUIRED, maximum_attempts: 1 });
    const failedFinal = await failQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-c', workerId: 'w1', leaseId: c.lease.lease_id, errorMessage: 'consequential failure' });
    assert.equal(failedFinal.item.state, QUEUE_STATES.FAILED_FINAL, 'HUMAN_REQUIRED never becomes FAILED_RETRYABLE');
  });
});

test('20+25. FAILED_FINAL dead-letters with full source history preserved', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const c = await leased(dir, timeself, { queue_item_id: 'qi-dl', retry_class: RETRY_CLASSES.NEVER, maximum_attempts: 1 });
    await failQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-dl', workerId: 'w1', leaseId: c.lease.lease_id, errorMessage: 'unsupported' });
    const dl = await deadLetterQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-dl', terminalReason: 'unsupported capability', requiredHumanAction: 'review' });
    assert.equal(dl.ok, true, dl.message);
    assert.equal(dl.source_item.state, QUEUE_STATES.DEAD_LETTERED);
    // Full original item (with lease + error history) preserved inside the dead letter.
    assert.equal(dl.dead_letter_item.payload.original_item.queue_item_id, 'qi-dl');
    assert.equal(dl.dead_letter_item.payload.original_item.last_error, 'unsupported');
    assert.equal(dl.dead_letter_item.payload.original_item.lease.lease_id, c.lease.lease_id);
    assert.equal(dl.dead_letter_item.payload.terminal_reason, 'unsupported capability');
    assert.equal(dl.dead_letter_item.retry_class, RETRY_CLASSES.NEVER);
    // Source file still exists and is integrity-valid.
    const source = await getQueueItem(dir, 'witness', 'qi-dl');
    assert.equal(source.valid, true);
    assert.equal((await verifyEventLedger(dir)).valid, true);
  });
});

test('21-24. illegal transitions, non-holder transitions, and duplicate completion law', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    const enq = await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-t' }));
    // 21: cannot complete a QUEUED (never leased) item.
    const straightToDone = await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-t', workerId: 'w1', leaseId: 'lease-x' });
    assert.equal(straightToDone.ok, false);
    const l = await leaseQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-t', workerId: 'w1', runtimeInstanceId: 'rt-1' });
    // 22: transition by non-holder rejected.
    const intruder = await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-t', workerId: 'intruder', leaseId: l.item.lease.lease_id });
    assert.equal(intruder.ok, false);
    assert.equal(intruder.error, ERR.LEASE_NOT_HELD);
    // 23: duplicate completion by the same holder is idempotent.
    await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-t', workerId: 'w1', leaseId: l.item.lease.lease_id });
    const dup = await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-t', workerId: 'w1', leaseId: l.item.lease.lease_id });
    assert.equal(dup.idempotent, true);
    // 24: conflicting completion by another caller rejected.
    const conflicting = await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-t', workerId: 'w2', leaseId: 'lease-other' });
    assert.equal(conflicting.ok, false);
    assert.ok(enq.ok);
  });
});

// ═════════════ Leasing (26-35) ═══════════════════════════════════════════════

test('26-27. exactly one of two concurrent callers acquires the lease', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-race' }));
    const [a, b] = await Promise.all([
      leaseQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-race', workerId: 'wA', runtimeInstanceId: 'rt-1' }),
      leaseQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-race', workerId: 'wB', runtimeInstanceId: 'rt-1' }),
    ]);
    const winners = [a, b].filter((r) => r.ok);
    const losers = [a, b].filter((r) => !r.ok && (r.error === ERR.LEASE_CONFLICT || r.error === ERR.ILLEGAL_QUEUE_TRANSITION));
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
  });
});

test('28-30. renewal by holder works; by non-holder fails; expired holder cannot complete', async () => {
  await withTempStore(async (dir) => {
    const { clock, timeself } = fakeTimeself();
    const { lease } = await leased(dir, timeself, { queue_item_id: 'qi-renew' });
    const renewed = await renewLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-renew', workerId: 'w1', leaseId: lease.lease_id, leaseDurationMs: 60_000 });
    assert.equal(renewed.ok, true, renewed.message);
    const stranger = await renewLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-renew', workerId: 'stranger', leaseId: lease.lease_id });
    assert.equal(stranger.ok, false);
    clock.advance(120_000); // lease expires
    const lateComplete = await completeQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-renew', workerId: 'w1', leaseId: lease.lease_id });
    assert.equal(lateComplete.ok, false);
    assert.equal(lateComplete.error, ERR.LEASE_EXPIRED);
    const lateRenew = await renewLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-renew', workerId: 'w1', leaseId: lease.lease_id });
    assert.equal(lateRenew.error, ERR.LEASE_EXPIRED);
  });
});

test('31-32. expired SAFE lease is reclaimable with proof; HUMAN_REQUIRED is never auto-reclaimed', async () => {
  await withTempStore(async (dir) => {
    const { clock, timeself } = fakeTimeself();
    const safe = await leased(dir, timeself, { queue_item_id: 'qi-safe' });
    const human = await leased(dir, timeself, { queue_item_id: 'qi-human', retry_class: RETRY_CLASSES.HUMAN_REQUIRED, maximum_attempts: 5 });
    clock.advance(120_000);
    const safeItem = (await getQueueItem(dir, 'witness', 'qi-safe')).item;
    const humanItem = (await getQueueItem(dir, 'witness', 'qi-human')).item;
    assert.equal(classifyExpiredLease(safeItem, timeself).classification, 'RECLAIMABLE_SAFE');
    assert.equal(classifyExpiredLease(humanItem, timeself).classification, 'HUMAN_REQUIRED');
    const noProof = await reclaimExpiredLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-safe', runtimeInstanceId: 'rt-2' });
    assert.equal(noProof.ok, false, 'expiry alone is not proof the owner is dead');
    const reclaimed = await reclaimExpiredLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-safe', runtimeInstanceId: 'rt-2', ownerLivenessVerdict: { ownerDead: true, evidence: 'injected verifier: pid absent, heartbeat stale' } });
    assert.equal(reclaimed.ok, true, reclaimed.message);
    assert.equal(reclaimed.item.state, QUEUE_STATES.QUEUED);
    const humanReclaim = await reclaimExpiredLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-human', runtimeInstanceId: 'rt-2', ownerLivenessVerdict: { ownerDead: true, evidence: 'x' } });
    assert.equal(humanReclaim.ok, false);
    assert.equal(humanReclaim.error, ERR.RECLAIM_FORBIDDEN);
    assert.ok(safe.item && human.item);
  });
});

test('33-35. lease generations increase; stale lease artifacts persist; lease integrity verifies', async () => {
  await withTempStore(async (dir) => {
    const { clock, timeself } = fakeTimeself();
    const first = await leased(dir, timeself, { queue_item_id: 'qi-gen' });
    assert.equal(first.lease.lease_generation, 1);
    clock.advance(120_000);
    await reclaimExpiredLease(dir, timeself, { queueName: 'witness', queueItemId: 'qi-gen', ownerLivenessVerdict: { ownerDead: true, evidence: 'proof' } });
    const second = await leaseQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-gen', workerId: 'w2', runtimeInstanceId: 'rt-2' });
    assert.equal(second.ok, true, second.message);
    assert.equal(second.item.lease.lease_generation, 2, 'generation increases');
    // 34: the generation-1 claim artifact still exists — never silently deleted.
    const staleClaim = await readFile(join(dir, 'queues', 'witness', 'qi-gen.lease-1.lock'), 'utf8');
    assert.ok(staleClaim.includes('"generation":1'));
    // 35: lease integrity.
    const shape = verifyQueueItemShape(second.item);
    assert.equal(shape.valid, true, JSON.stringify(shape.details));
  });
});

test('cancel: QUEUED item cancels explicitly and terminally', async () => {
  await withTempStore(async (dir) => {
    const { timeself } = fakeTimeself();
    await enqueueQueueItem(dir, timeself, itemInput({ queue_item_id: 'qi-cancel' }));
    const cancelled = await cancelQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-cancel', reason: 'explicit HUMAN-TURN cancellation' });
    assert.equal(cancelled.item.state, QUEUE_STATES.CANCELLED);
    const release = await leaseQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-cancel', workerId: 'w1', runtimeInstanceId: 'rt-1' });
    assert.equal(release.ok, false, 'a cancelled item can never be leased');
  });
});

test('retry requeue: SAFE_AUTOMATIC failed item re-queues; queue names are the frozen T-034 set', async () => {
  await withTempStore(async (dir) => {
    const { clock, timeself } = fakeTimeself();
    const { lease } = await leased(dir, timeself, { queue_item_id: 'qi-retry' });
    await failQueueItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-retry', workerId: 'w1', leaseId: lease.lease_id, errorMessage: 'transient' });
    clock.advance(60 * 60_000);
    const requeued = await requeueRetryableItem(dir, timeself, { queueName: 'witness', queueItemId: 'qi-retry' });
    assert.equal(requeued.ok, true, requeued.message);
    assert.equal(requeued.item.state, QUEUE_STATES.QUEUED);
    assert.deepEqual([...QUEUE_NAMES].sort(), ['dead-letter', 'execution', 'human-decision', 'memory-update', 'proposal', 'reconciliation', 'runtime-control', 'witness'].sort());
  });
});
