// persistence/queue-store.js
// ── T-034: Durable queue infrastructure for the OURSELF authority plane ─────
//
// PURPOSE
//   Provide crash-safe, integrity-hashed, event-ledgered queue items with
//   exclusive leases, explicit retry classes, and dead-letter preservation —
//   the durable substrate the T-034 runtime organism operates over.
//
// FOUNDATIONAL LAW
//   PERSISTED ≠ SAFELY LEASED. AVAILABLE ≠ AUTHORIZED. RETRYABLE ≠ LAWFULLY
//   REPEATABLE. A queue state never replaces proposal authority state: queue
//   items REFERENCE authority (by proposal id / event hash); they never grant,
//   alter, or stand in for it. Consequential work (retry_class HUMAN_REQUIRED
//   or NEVER) is never automatically reclaimed into execution.
//
// PLANE LAW (material architecture decision, recorded)
//   These queues belong to the sealed T-030–T-033 authority plane: they share
//   the SAME storageRoot and the SAME hash-chained events.jsonl ledger. The
//   legacy Pass-20 in-memory pending lane and logs/queue.jsonl remain
//   untouched, unextended, and unconsumed. Live runtime state never lives
//   inside the Git repository.
//
// STORAGE
//   <storageRoot>/queues/<queue-name>/<queue-item-id>.json  — canonical item
//   <storageRoot>/queues/<queue-name>/<queue-item-id>.lease-<generation>.lock
//     — O_EXCL lease-acquisition claim (never silently deleted)
//
// HARD INVARIANTS (this module NEVER)
//   • creates, alters, or consumes HUMAN-TURN authority;
//   • executes a proposal or spawns a process;
//   • reruns T-032 execution through any retry path;
//   • deletes or overwrites source history on dead-letter;
//   • trusts an in-memory view over the durable record;
//   • repairs a corrupted item silently.

'use strict';

import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  atomicWriteJson,
  appendGlobalEvent,
  assertNotSymlink,
} from './pending-proposals.js';
import { canonicalHash } from './canonical-json.js';

export const QUEUE_ITEM_VERSION = 'ourself.queue-item.v1';
export const QUEUE_EVENT_VERSION = 'ourself.queue-event.v1';

export const QUEUE_NAMES = Object.freeze([
  'proposal',
  'human-decision',
  'execution',
  'witness',
  'reconciliation',
  'memory-update',
  'runtime-control',
  'dead-letter',
]);

export const QUEUE_STATES = Object.freeze({
  QUEUED: 'QUEUED',
  LEASED: 'LEASED',
  COMPLETED: 'COMPLETED',
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  FAILED_FINAL: 'FAILED_FINAL',
  DEAD_LETTERED: 'DEAD_LETTERED',
  CANCELLED: 'CANCELLED',
});

export const RETRY_CLASSES = Object.freeze({
  SAFE_AUTOMATIC: 'SAFE_AUTOMATIC',
  HUMAN_REQUIRED: 'HUMAN_REQUIRED',
  NEVER: 'NEVER',
});

export const QUEUE_STORE_ERRORS = Object.freeze({
  INVALID_QUEUE_ITEM: 'INVALID_QUEUE_ITEM',
  UNSAFE_QUEUE_NAME: 'UNSAFE_QUEUE_NAME',
  UNSAFE_QUEUE_ITEM_ID: 'UNSAFE_QUEUE_ITEM_ID',
  QUEUE_BOUNDARY_VIOLATION: 'QUEUE_BOUNDARY_VIOLATION',
  QUEUE_ITEM_NOT_FOUND: 'QUEUE_ITEM_NOT_FOUND',
  QUEUE_ITEM_CORRUPTED: 'QUEUE_ITEM_CORRUPTED',
  QUEUE_ITEM_ALREADY_ENQUEUED: 'QUEUE_ITEM_ALREADY_ENQUEUED',
  QUEUE_ITEM_IDENTITY_CONFLICT: 'QUEUE_ITEM_IDENTITY_CONFLICT',
  ILLEGAL_QUEUE_TRANSITION: 'ILLEGAL_QUEUE_TRANSITION',
  LEASE_CONFLICT: 'LEASE_CONFLICT',
  LEASE_NOT_HELD: 'LEASE_NOT_HELD',
  LEASE_EXPIRED: 'LEASE_EXPIRED',
  ITEM_NOT_ELIGIBLE: 'ITEM_NOT_ELIGIBLE',
  RECLAIM_FORBIDDEN: 'RECLAIM_FORBIDDEN',
  QUEUE_WRITE_FAILED: 'QUEUE_WRITE_FAILED',
});

const ERR = QUEUE_STORE_ERRORS;

// Bare filename segment only — same law as proposal IDs.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// Legal state machine. Reclaim (LEASED→QUEUED after proven expiry) and retry
// re-queue (FAILED_RETRYABLE→QUEUED) are modeled explicitly.
const LEGAL_TRANSITIONS = Object.freeze({
  QUEUED: ['LEASED', 'CANCELLED'],
  LEASED: ['COMPLETED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'QUEUED', 'CANCELLED'],
  FAILED_RETRYABLE: ['QUEUED', 'FAILED_FINAL', 'DEAD_LETTERED', 'CANCELLED'],
  FAILED_FINAL: ['DEAD_LETTERED'],
  COMPLETED: [],
  DEAD_LETTERED: [],
  CANCELLED: [],
});

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

function queuesDir(storageRoot) {
  return join(storageRoot, 'queues');
}

export function resolveQueueItemPath(storageRoot, queueName, queueItemId) {
  if (typeof queueName !== 'string' || !QUEUE_NAMES.includes(queueName)) {
    return { ok: false, error: ERR.UNSAFE_QUEUE_NAME };
  }
  if (typeof queueItemId !== 'string' || !SAFE_ID.test(queueItemId)) {
    return { ok: false, error: ERR.UNSAFE_QUEUE_ITEM_ID };
  }
  const dir = resolve(join(queuesDir(storageRoot), queueName));
  const target = resolve(dir, `${queueItemId}.json`);
  if (!target.startsWith(dir + sep)) {
    return { ok: false, error: ERR.QUEUE_BOUNDARY_VIOLATION };
  }
  return { ok: true, dir, target };
}

export function computePayloadHash(payload) {
  return canonicalHash(payload ?? null);
}

export function computeQueueItemHash(item) {
  const { item_hash, ...rest } = item;
  return canonicalHash(rest);
}

export function computeLeaseHash(lease) {
  const { lease_hash, ...rest } = lease;
  return canonicalHash(rest);
}

/** Full integrity verification of one durable queue item. Read-only. */
export function verifyQueueItemShape(item) {
  const details = [];
  if (!item || typeof item !== 'object') return { valid: false, details: ['not_an_object'] };
  if (item.queue_item_version !== QUEUE_ITEM_VERSION) details.push('invalid_item_version');
  if (typeof item.queue_item_id !== 'string' || !SAFE_ID.test(item.queue_item_id)) details.push('invalid_item_id');
  if (!QUEUE_NAMES.includes(item.queue_name)) details.push('invalid_queue_name');
  if (typeof item.item_type !== 'string' || item.item_type.length === 0) details.push('invalid_item_type');
  if (typeof item.producer_self !== 'string' || item.producer_self.length === 0) details.push('invalid_producer');
  if (typeof item.intended_consumer_self !== 'string' || item.intended_consumer_self.length === 0) details.push('invalid_consumer');
  if (typeof item.correlation_id !== 'string' || item.correlation_id.length === 0) details.push('invalid_correlation_id');
  if (!Object.values(QUEUE_STATES).includes(item.state)) details.push('invalid_state');
  if (!Object.values(RETRY_CLASSES).includes(item.retry_class)) details.push('invalid_retry_class');
  if (!Number.isInteger(item.attempt_count) || item.attempt_count < 0) details.push('invalid_attempt_count');
  if (!Number.isInteger(item.maximum_attempts) || item.maximum_attempts < 1) details.push('invalid_maximum_attempts');
  if (typeof item.created_at !== 'string') details.push('invalid_created_at');
  if (item.expires_at !== 'NO_EXPIRY' && typeof item.expires_at !== 'string') details.push('invalid_expires_at');
  if (computePayloadHash(item.payload) !== item.payload_hash) details.push('payload_hash_mismatch');
  if (computeQueueItemHash(item) !== item.item_hash) details.push('item_hash_mismatch');
  if (item.lease && computeLeaseHash(item.lease) !== item.lease.lease_hash) details.push('lease_hash_mismatch');
  return { valid: details.length === 0, details };
}

async function readQueueItem(storageRoot, queueName, queueItemId) {
  const resolved = resolveQueueItemPath(storageRoot, queueName, queueItemId);
  if (!resolved.ok) return fail(resolved.error);
  if (!(await assertNotSymlink(resolved.target))) {
    return fail(ERR.QUEUE_BOUNDARY_VIOLATION, 'refusing to follow a symlinked queue item');
  }
  const raw = await readFile(resolved.target, 'utf8').catch(() => null);
  if (raw === null) return fail(ERR.QUEUE_ITEM_NOT_FOUND);
  let item;
  try {
    item = JSON.parse(raw);
  } catch {
    return fail(ERR.QUEUE_ITEM_CORRUPTED, 'queue item is malformed JSON');
  }
  return { ok: true, item, target: resolved.target };
}

async function writeQueueItem(target, item) {
  if (!(await assertNotSymlink(target))) {
    throw new Error('queue item path is no longer safe to write');
  }
  await atomicWriteJson(target, item);
}

async function appendQueueEvent(storageRoot, timeself, type, item, extra = {}) {
  return appendGlobalEvent(storageRoot, {
    event_version: QUEUE_EVENT_VERSION,
    type,
    queue_item_id: item.queue_item_id,
    queue_name: item.queue_name,
    correlation_id: item.correlation_id,
    item_hash: item.item_hash,
    at: timeself.now(),
    ...extra,
  });
}

/** Read-only fetch with integrity verdict. */
export async function getQueueItem(storageRoot, queueName, queueItemId) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const integrity = verifyQueueItemShape(got.item);
  return { ok: true, item: got.item, valid: integrity.valid, details: integrity.details };
}

/**
 * List a queue. Healthy and corrupted items are returned separately — one bad
 * item never hides the valid ones. State is reconstructed directly from disk.
 */
export async function listQueueItems(storageRoot, queueName) {
  if (!QUEUE_NAMES.includes(queueName)) return fail(ERR.UNSAFE_QUEUE_NAME);
  const dir = join(queuesDir(storageRoot), queueName);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const items = [];
  const corrupted = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const id = entry.name.slice(0, -'.json'.length);
    const got = await getQueueItem(storageRoot, queueName, id);
    if (got.ok && got.valid) items.push(got.item);
    else corrupted.push({ queue_item_id: id, error: got.error ?? ERR.QUEUE_ITEM_CORRUPTED, details: got.details ?? [] });
  }
  items.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.created_at || '').localeCompare(b.created_at || '') || a.queue_item_id.localeCompare(b.queue_item_id));
  return { ok: true, items, corrupted };
}

/**
 * Enqueue one durable queue item. Idempotent on byte-identical logical repeat;
 * fails closed on same-ID/different-content. Appends QUEUE_ITEM_ENQUEUED.
 */
export async function enqueueQueueItem(storageRoot, timeself, input) {
  if (!input || typeof input !== 'object') return fail(ERR.INVALID_QUEUE_ITEM, 'input must be an object');
  const createdAt = timeself.now();
  const item = {
    queue_item_version: QUEUE_ITEM_VERSION,
    queue_item_id: input.queue_item_id,
    queue_name: input.queue_name,
    item_type: input.item_type,
    producer_self: input.producer_self,
    intended_consumer_self: input.intended_consumer_self,
    correlation_id: input.correlation_id,
    parent_event_hash: input.parent_event_hash ?? null,
    authority_state: input.authority_state ?? null,
    payload: input.payload ?? null,
    payload_hash: computePayloadHash(input.payload ?? null),
    priority: Number.isInteger(input.priority) ? input.priority : 0,
    created_at: input.created_at ?? createdAt,
    eligible_at: input.eligible_at ?? createdAt,
    expires_at: input.expires_at ?? 'NO_EXPIRY',
    attempt_count: 0,
    maximum_attempts: Number.isInteger(input.maximum_attempts) ? input.maximum_attempts : 3,
    retry_class: input.retry_class,
    lease: null,
    state: QUEUE_STATES.QUEUED,
    last_error: null,
    item_hash: null,
  };
  item.item_hash = computeQueueItemHash(item);

  const shape = verifyQueueItemShape(item);
  if (!shape.valid) {
    const idBad = shape.details.includes('invalid_item_id');
    const nameBad = shape.details.includes('invalid_queue_name');
    return fail(nameBad ? ERR.UNSAFE_QUEUE_NAME : idBad ? ERR.UNSAFE_QUEUE_ITEM_ID : ERR.INVALID_QUEUE_ITEM, JSON.stringify(shape.details));
  }

  const resolved = resolveQueueItemPath(storageRoot, item.queue_name, item.queue_item_id);
  if (!resolved.ok) return fail(resolved.error);
  if (!(await assertNotSymlink(resolved.target))) {
    return fail(ERR.QUEUE_BOUNDARY_VIOLATION, 'refusing to follow a symlinked queue item');
  }

  const existingRaw = await readFile(resolved.target, 'utf8').catch(() => null);
  if (existingRaw !== null) {
    let existing;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      return fail(ERR.QUEUE_ITEM_CORRUPTED, 'existing queue item is malformed JSON');
    }
    // Identity = same logical content (payload + routing), regardless of timestamps.
    const identityOf = (i) => canonicalHash({
      queue_name: i.queue_name, item_type: i.item_type, payload_hash: i.payload_hash,
      correlation_id: i.correlation_id, intended_consumer_self: i.intended_consumer_self, retry_class: i.retry_class,
    });
    if (identityOf(existing) === identityOf(item)) {
      return { ok: true, idempotent: true, code: ERR.QUEUE_ITEM_ALREADY_ENQUEUED, item: existing };
    }
    return fail(ERR.QUEUE_ITEM_IDENTITY_CONFLICT, 'queue item id already exists with different content');
  }

  let event;
  try {
    event = await appendQueueEvent(storageRoot, timeself, 'QUEUE_ITEM_ENQUEUED', item, {
      prior_state: null, next_state: QUEUE_STATES.QUEUED,
      runtime_instance_id: input.runtime_instance_id ?? null, worker_id: null,
    });
    await mkdir(resolved.dir, { recursive: true });
    await writeQueueItem(resolved.target, item);
  } catch (err) {
    return fail(ERR.QUEUE_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, idempotent: false, item, event_hash: event.event_hash };
}

function transitionAllowed(from, to) {
  return (LEGAL_TRANSITIONS[from] || []).includes(to);
}

/**
 * Apply one legal state transition with fresh-read validation, an appended
 * ledger event, and an atomic rewrite. Internal helper for the operations
 * below — never exported raw so no caller can invent a transition.
 */
async function applyTransition(storageRoot, timeself, { queueName, queueItemId, nextState, mutate, eventType, requireHolder, extra = {} }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  const integrity = verifyQueueItemShape(item);
  if (!integrity.valid) {
    return fail(ERR.QUEUE_ITEM_CORRUPTED, JSON.stringify(integrity.details));
  }
  if (!transitionAllowed(item.state, nextState)) {
    return fail(ERR.ILLEGAL_QUEUE_TRANSITION, `${item.state} → ${nextState} is not a legal transition`);
  }
  if (requireHolder) {
    const lease = item.lease;
    if (!lease || lease.worker_id !== requireHolder.workerId || lease.lease_id !== requireHolder.leaseId) {
      return fail(ERR.LEASE_NOT_HELD, 'only the current lease holder may perform this transition');
    }
    if (requireHolder.mustBeUnexpired && timeself.isLeaseExpired(lease)) {
      return fail(ERR.LEASE_EXPIRED, 'the holder’s lease has expired — completion is no longer lawful');
    }
  }
  const priorState = item.state;
  const updated = { ...item, state: nextState };
  if (mutate) mutate(updated);
  updated.item_hash = null;
  updated.item_hash = computeQueueItemHash(updated);

  try {
    await appendQueueEvent(storageRoot, timeself, eventType, updated, {
      prior_state: priorState, next_state: nextState,
      worker_id: requireHolder?.workerId ?? extra.worker_id ?? null,
      runtime_instance_id: extra.runtime_instance_id ?? null,
      ...extra.event ?? {},
    });
    await writeQueueItem(got.target, updated);
  } catch (err) {
    return fail(ERR.QUEUE_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, item: updated, prior_state: priorState };
}

/**
 * Acquire an exclusive lease on an eligible QUEUED item. Exclusivity is
 * enforced by an O_EXCL per-generation claim file — a concurrent caller
 * deterministically loses. The claim file is never deleted by this module.
 */
export async function leaseQueueItem(storageRoot, timeself, { queueName, queueItemId, workerId, runtimeInstanceId, leaseDurationMs }) {
  if (typeof workerId !== 'string' || workerId.length === 0 || typeof runtimeInstanceId !== 'string' || runtimeInstanceId.length === 0) {
    return fail(ERR.INVALID_QUEUE_ITEM, 'workerId and runtimeInstanceId are required');
  }
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  const integrity = verifyQueueItemShape(item);
  if (!integrity.valid) return fail(ERR.QUEUE_ITEM_CORRUPTED, JSON.stringify(integrity.details));
  if (item.state !== QUEUE_STATES.QUEUED) {
    return fail(ERR.ILLEGAL_QUEUE_TRANSITION, `only a QUEUED item can be leased (state: ${item.state})`);
  }
  if (!timeself.isEligible(item)) return fail(ERR.ITEM_NOT_ELIGIBLE, 'item is not yet eligible');
  if (timeself.isExpired(item)) return fail(ERR.ITEM_NOT_ELIGIBLE, 'item has expired');

  const generation = (item.lease?.lease_generation ?? item.last_lease_generation ?? 0) + 1;
  const claimPath = `${got.target.slice(0, -'.json'.length)}.lease-${generation}.lock`;
  if (!(await assertNotSymlink(claimPath))) {
    return fail(ERR.LEASE_CONFLICT, 'lease claim path is a symlink — refusing');
  }
  try {
    await writeFile(claimPath, JSON.stringify({ queue_item_id: queueItemId, worker_id: workerId, runtime_instance_id: runtimeInstanceId, generation, claimed_at: timeself.now() }) + '\n', { flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      return fail(ERR.LEASE_CONFLICT, 'another worker already claimed this lease generation');
    }
    return fail(ERR.QUEUE_WRITE_FAILED, String(err && err.message || err));
  }

  const lease = {
    lease_id: `lease-${queueItemId}-g${generation}`,
    worker_id: workerId,
    runtime_instance_id: runtimeInstanceId,
    leased_at: timeself.now(),
    lease_expires_at: timeself.leaseDeadline(leaseDurationMs),
    lease_generation: generation,
    lease_hash: null,
  };
  lease.lease_hash = computeLeaseHash(lease);

  return applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState: QUEUE_STATES.LEASED,
    mutate: (u) => { u.lease = lease; u.last_lease_generation = generation; u.attempt_count = item.attempt_count + 1; },
    eventType: 'QUEUE_ITEM_LEASED',
    extra: { worker_id: workerId, runtime_instance_id: runtimeInstanceId, event: { lease_id: lease.lease_id, lease_generation: generation } },
  });
}

/** Renew a lease — current holder only. */
export async function renewLease(storageRoot, timeself, { queueName, queueItemId, workerId, leaseId, leaseDurationMs }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  const lease = item.lease;
  if (item.state !== QUEUE_STATES.LEASED || !lease) return fail(ERR.LEASE_NOT_HELD, 'item is not leased');
  if (lease.worker_id !== workerId || lease.lease_id !== leaseId) return fail(ERR.LEASE_NOT_HELD, 'only the current lease holder may renew');
  if (timeself.isLeaseExpired(lease)) return fail(ERR.LEASE_EXPIRED, 'an expired lease cannot be renewed');
  const renewed = { ...lease, lease_expires_at: timeself.leaseDeadline(leaseDurationMs), lease_hash: null };
  renewed.lease_hash = computeLeaseHash(renewed);
  const updated = { ...item, lease: renewed, item_hash: null };
  updated.item_hash = computeQueueItemHash(updated);
  try {
    await appendQueueEvent(storageRoot, timeself, 'QUEUE_ITEM_LEASE_RENEWED', updated, {
      prior_state: item.state, next_state: item.state, worker_id: workerId,
      runtime_instance_id: lease.runtime_instance_id, lease_id: leaseId, lease_generation: lease.lease_generation,
    });
    await writeQueueItem(got.target, updated);
  } catch (err) {
    return fail(ERR.QUEUE_WRITE_FAILED, String(err && err.message || err));
  }
  return { ok: true, item: updated };
}

/** Complete a leased item — unexpired current holder only. Duplicate completion by the same holder is idempotent. */
export async function completeQueueItem(storageRoot, timeself, { queueName, queueItemId, workerId, leaseId, result = null }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  if (item.state === QUEUE_STATES.COMPLETED) {
    if (item.completed_by?.worker_id === workerId && item.completed_by?.lease_id === leaseId) {
      return { ok: true, idempotent: true, item };
    }
    return fail(ERR.ILLEGAL_QUEUE_TRANSITION, 'item was completed by a different holder');
  }
  return applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState: QUEUE_STATES.COMPLETED,
    requireHolder: { workerId, leaseId, mustBeUnexpired: true },
    mutate: (u) => {
      u.completed_at = timeself.now();
      u.completed_by = { worker_id: workerId, lease_id: leaseId, runtime_instance_id: u.lease.runtime_instance_id };
      u.result_hash = canonicalHash(result ?? null);
      u.lease = { ...u.lease };
    },
    eventType: 'QUEUE_ITEM_COMPLETED',
  });
}

/** Fail a leased item — current holder only. Retry class law decides the terminal shape. */
export async function failQueueItem(storageRoot, timeself, { queueName, queueItemId, workerId, leaseId, errorMessage, retryPolicy }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  const boundedError = String(errorMessage ?? 'unspecified failure').slice(0, 500);
  const retryable =
    item.retry_class === RETRY_CLASSES.SAFE_AUTOMATIC &&
    item.attempt_count < item.maximum_attempts;
  const nextState = retryable ? QUEUE_STATES.FAILED_RETRYABLE : QUEUE_STATES.FAILED_FINAL;
  return applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState,
    requireHolder: { workerId, leaseId },
    mutate: (u) => {
      u.last_error = boundedError;
      u.failed_at = timeself.now();
      if (retryable) u.eligible_at = timeself.retryDeadline(retryPolicy, u.attempt_count);
    },
    eventType: retryable ? 'QUEUE_ITEM_FAILED_RETRYABLE' : 'QUEUE_ITEM_FAILED_FINAL',
    extra: { event: { failure: boundedError, retry_class: item.retry_class } },
  });
}

/** Re-queue a FAILED_RETRYABLE item once its retry deadline computes eligibility. SAFE_AUTOMATIC only. */
export async function requeueRetryableItem(storageRoot, timeself, { queueName, queueItemId, runtimeInstanceId }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  if (item.retry_class !== RETRY_CLASSES.SAFE_AUTOMATIC) {
    return fail(ERR.RECLAIM_FORBIDDEN, `retry class ${item.retry_class} may never be automatically re-queued`);
  }
  return applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState: QUEUE_STATES.QUEUED,
    mutate: (u) => { u.lease = null; },
    eventType: 'QUEUE_ITEM_RECLAIMED',
    extra: { runtime_instance_id: runtimeInstanceId ?? null },
  });
}

/**
 * Classify an expired lease. Pure law: SAFE_AUTOMATIC with remaining attempts
 * is reclaimable; HUMAN_REQUIRED and NEVER are not — they surface for HUMAN-TURN.
 */
export function classifyExpiredLease(item, timeself) {
  if (item.state !== QUEUE_STATES.LEASED || !item.lease) return { expired: false, reclaimable: false, classification: 'NOT_LEASED' };
  if (!timeself.isLeaseExpired(item.lease)) return { expired: false, reclaimable: false, classification: 'LEASE_ACTIVE' };
  if (item.retry_class === RETRY_CLASSES.SAFE_AUTOMATIC && item.attempt_count < item.maximum_attempts) {
    return { expired: true, reclaimable: true, classification: 'RECLAIMABLE_SAFE' };
  }
  return { expired: true, reclaimable: false, classification: 'HUMAN_REQUIRED' };
}

/**
 * Reclaim an expired SAFE_AUTOMATIC lease back to QUEUED. Requires an explicit
 * prior-owner liveness verdict — an expired timestamp alone is NOT proof the
 * owner is dead. Consequential items can never pass this gate.
 */
export async function reclaimExpiredLease(storageRoot, timeself, { queueName, queueItemId, runtimeInstanceId, ownerLivenessVerdict }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const item = got.item;
  const cls = classifyExpiredLease(item, timeself);
  if (!cls.expired) return fail(ERR.RECLAIM_FORBIDDEN, 'lease is not expired');
  if (!cls.reclaimable) return fail(ERR.RECLAIM_FORBIDDEN, `expired lease is ${cls.classification} — automatic reclaim is forbidden`);
  if (!ownerLivenessVerdict || ownerLivenessVerdict.ownerDead !== true || typeof ownerLivenessVerdict.evidence !== 'string') {
    return fail(ERR.RECLAIM_FORBIDDEN, 'reclaim requires an explicit prior-owner-dead verdict with evidence');
  }
  try {
    await appendQueueEvent(storageRoot, timeself, 'QUEUE_ITEM_LEASE_EXPIRED', item, {
      prior_state: item.state, next_state: item.state,
      worker_id: item.lease.worker_id, runtime_instance_id: runtimeInstanceId ?? null,
      lease_id: item.lease.lease_id, liveness_evidence: ownerLivenessVerdict.evidence.slice(0, 300),
    });
  } catch (err) {
    return fail(ERR.QUEUE_WRITE_FAILED, String(err && err.message || err));
  }
  return applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState: QUEUE_STATES.QUEUED,
    mutate: (u) => { u.lease = null; },
    eventType: 'QUEUE_ITEM_RECLAIMED',
    extra: { runtime_instance_id: runtimeInstanceId ?? null },
  });
}

/** Cancel a QUEUED / LEASED / FAILED_RETRYABLE item explicitly. */
export async function cancelQueueItem(storageRoot, timeself, { queueName, queueItemId, reason, runtimeInstanceId }) {
  return applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState: QUEUE_STATES.CANCELLED,
    mutate: (u) => { u.cancelled_at = timeself.now(); u.last_error = String(reason ?? 'cancelled').slice(0, 500); u.lease = null; },
    eventType: 'QUEUE_ITEM_CANCELLED',
    extra: { runtime_instance_id: runtimeInstanceId ?? null },
  });
}

/**
 * Dead-letter a FAILED_FINAL (or FAILED_RETRYABLE-exhausted) item: a full copy
 * — original item, attempts, lease, terminal reason, integrity hashes, source
 * queue, timestamp, required HUMAN-TURN action — is written into the
 * dead-letter queue. The SOURCE item is marked DEAD_LETTERED in place; its
 * history is never erased or overwritten.
 */
export async function deadLetterQueueItem(storageRoot, timeself, { queueName, queueItemId, terminalReason, requiredHumanAction, runtimeInstanceId }) {
  const got = await readQueueItem(storageRoot, queueName, queueItemId);
  if (!got.ok) return got;
  const source = got.item;
  const deadLetterId = `dl-${source.queue_item_id}`;
  const deadPayload = {
    original_item: source,
    source_queue: queueName,
    terminal_reason: String(terminalReason ?? source.last_error ?? 'unspecified').slice(0, 500),
    required_human_action: String(requiredHumanAction ?? 'HUMAN-TURN review required').slice(0, 300),
    dead_lettered_at: timeself.now(),
  };
  const enq = await enqueueQueueItem(storageRoot, timeself, {
    queue_item_id: deadLetterId,
    queue_name: 'dead-letter',
    item_type: 'dead-letter-record',
    producer_self: 'RuntimeSELF',
    intended_consumer_self: 'HUMAN-TURN',
    correlation_id: source.correlation_id,
    parent_event_hash: source.item_hash,
    authority_state: source.authority_state,
    payload: deadPayload,
    retry_class: RETRY_CLASSES.NEVER,
    maximum_attempts: 1,
    runtime_instance_id: runtimeInstanceId ?? null,
  });
  if (!enq.ok) return enq;
  const marked = await applyTransition(storageRoot, timeself, {
    queueName, queueItemId, nextState: QUEUE_STATES.DEAD_LETTERED,
    mutate: (u) => { u.dead_letter_item_id = deadLetterId; u.dead_lettered_at = deadPayload.dead_lettered_at; },
    eventType: 'QUEUE_ITEM_DEAD_LETTERED',
    extra: { runtime_instance_id: runtimeInstanceId ?? null, event: { dead_letter_item_id: deadLetterId } },
  });
  if (!marked.ok) return marked;
  return { ok: true, dead_letter_item: enq.item, source_item: marked.item };
}
