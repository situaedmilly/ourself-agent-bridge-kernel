// runtime/orchestrator.js
// ── T-034: RuntimeSELF orchestrator — deterministic supervised service loop ─
//
// PURPOSE
//   One supervised in-process loop over: queue scanning, eligibility, leasing,
//   worker dispatch, completion, failure, retry scheduling, dead-letter
//   routing, heartbeat, readiness, and graceful shutdown.
//
// CONSEQUENTIAL-WORK CONTAINMENT (load-bearing)
//   The orchestrator consumes ONLY the safe queues: witness, reconciliation,
//   memory-update, runtime-control. The execution queue may hold authorized
//   pending work for display, but NO T-034 worker consumes it — this module
//   does not even import persistence/proposal-execution.js, so no code path
//   can invoke T-032. AUTHORIZED ≠ AUTOMATICALLY EXECUTED.
//
// WORKERS (the only four)
//   witness-worker         — sealed T-033 witness capture (read-only observation)
//   reconciliation-worker  — sealed T-033 reconciliation resume from persisted
//                            witness (never recollects, never re-executes)
//   memory-worker          — bounded runtime memory event in the operational
//                            ledger ONLY (never governance files, never Git)
//   health-worker          — read-only runtime and storage verification
//
//   No daemon per SELF. No network listener. No kill operation. No
//   operating-system service installation of any kind.

'use strict';

import { appendGlobalEvent } from '../persistence/pending-proposals.js';
import { createExecutionWitnessService, recordSemanticReconciliation } from '../persistence/semantic-reconciliation.js';
import {
  listQueueItems, leaseQueueItem, completeQueueItem, failQueueItem,
  requeueRetryableItem, deadLetterQueueItem,
  QUEUE_STATES, RETRY_CLASSES,
} from '../persistence/queue-store.js';
import { routeProposalRecord } from './bridge-self.js';
import {
  createRuntimeInstance, acquireRuntimeLock, releaseRuntimeLock,
  heartbeatRuntimeLock, writeRuntimeStatus, validateStorageRootBoundary,
  RUNTIME_STATUSES, RUNTIME_SELF_ERRORS,
} from './runtime-self.js';
import { runStartupRecovery } from './recovery.js';
import { computeHealth, computeReadiness } from './health.js';

export const ORCHESTRATOR_VERSION = 'ourself.orchestrator.v1';
export const RUNTIME_MEMORY_EVENT_VERSION = 'ourself.runtime-memory-event.v1';

// The ONLY queues the loop consumes. proposal / human-decision / execution /
// dead-letter are never leased by any T-034 worker.
const SAFE_CONSUMED_QUEUES = Object.freeze(['witness', 'reconciliation', 'memory-update', 'runtime-control']);

const CONSUMER_TO_WORKER = Object.freeze({
  'witness-worker': 'witness',
  'reconciliation-worker': 'reconciliation',
  'memory-worker': 'memory',
  'health-worker': 'health',
});

export const ORCHESTRATOR_ERRORS = Object.freeze({
  INVALID_ORCHESTRATOR_CONFIG: 'INVALID_ORCHESTRATOR_CONFIG',
  ORCHESTRATOR_NOT_READY: 'ORCHESTRATOR_NOT_READY',
  ORCHESTRATOR_DRAINING: 'ORCHESTRATOR_DRAINING',
  UNSUPPORTED_WORKER: 'UNSUPPORTED_WORKER',
});

const ERR = ORCHESTRATOR_ERRORS;

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

/**
 * Construct the supervised runtime. All configuration enters at trusted
 * construction; the loop itself takes no per-call untrusted parameters.
 */
export function createOrchestrator(config) {
  const cfg = config || {};
  if (typeof cfg.storageRoot !== 'string' || cfg.storageRoot.length === 0) {
    throw new TypeError('createOrchestrator requires storageRoot');
  }
  if (!cfg.timeself || typeof cfg.timeself.now !== 'function') {
    throw new TypeError('createOrchestrator requires an injected TIMESELF');
  }
  const storageRoot = cfg.storageRoot;
  const timeself = cfg.timeself;
  const leaseDurationMs = Number.isInteger(cfg.leaseDurationMs) ? cfg.leaseDurationMs : 60_000;
  const livenessVerifier = cfg.livenessVerifier;
  const observationRoot = cfg.authorizedObservationRoot ?? null;
  const spawnImpl = cfg.spawnImpl;

  let instance = null;
  let status = null;
  let recovery = null;
  let readiness = { ready: false, reasons: ['not_started'] };
  let draining = false;

  async function setStatus(next, extra = {}) {
    const res = await writeRuntimeStatus(storageRoot, timeself, instance, next, extra);
    if (res.ok) {
      instance = res.instance;
      status = next;
    }
    return res;
  }

  // ── Workers ────────────────────────────────────────────────────────────────

  async function witnessWorker(item) {
    if (!observationRoot) throw new Error('witness worker requires authorizedObservationRoot');
    const svc = createExecutionWitnessService({
      authorizedObservationRoot: observationRoot,
      now: () => timeself.now(),
      ...(spawnImpl ? { spawnImpl } : {}),
    });
    const res = await svc.captureExecutionWitness({ storageRoot, proposalId: item.payload.proposal_id });
    if (!res.ok) throw new Error(`witness capture failed: ${res.error}`);
    // Advance the causal chain: witness-complete records now route to reconciliation.
    await routeProposalRecord(storageRoot, timeself, { proposalId: item.payload.proposal_id, runtimeInstanceId: instance.runtime_instance_id });
    return { witnessed: true, witness_hash: res.witness?.witness_hash ?? res.record?.witness?.witness_hash ?? null };
  }

  async function reconciliationWorker(item) {
    // Resumes from the persisted witness ONLY — the sealed module never
    // recollects an observation and never touches T-032 execution.
    const res = await recordSemanticReconciliation(
      { storageRoot, proposalId: item.payload.proposal_id },
      { now: () => timeself.now() },
    );
    if (!res.ok) throw new Error(`reconciliation failed: ${res.error}`);
    await routeProposalRecord(storageRoot, timeself, { proposalId: item.payload.proposal_id, runtimeInstanceId: instance.runtime_instance_id });
    return { status: res.status ?? res.reconciliation?.status ?? null };
  }

  async function memoryWorker(item) {
    // Bounded runtime memory event in the operational ledger only. Governance
    // memory (the control-plane master file, handoff, and task ledger) and
    // Git are never touched by this worker — that memory stays HUMAN-TURN sealed.
    const event = await appendGlobalEvent(storageRoot, {
      event_version: RUNTIME_MEMORY_EVENT_VERSION,
      type: 'RUNTIME_MEMORY_EVENT',
      memory_kind: 'causal-unit-reconciled',
      proposal_id: item.payload?.proposal_id ?? null,
      correlation_id: item.correlation_id,
      runtime_instance_id: instance.runtime_instance_id,
      at: timeself.now(),
    });
    return { memory_event_hash: event.event_hash };
  }

  async function healthWorker() {
    const health = await computeHealth(storageRoot, timeself, instance);
    return { health };
  }

  const WORKERS = Object.freeze({
    witness: witnessWorker,
    reconciliation: reconciliationWorker,
    memory: memoryWorker,
    health: healthWorker,
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async function start() {
    // 1–2. configuration + storage boundary.
    const boundary = await validateStorageRootBoundary(storageRoot);
    if (!boundary.ok) return boundary;
    // 3. exclusive runtime lock.
    instance = createRuntimeInstance({
      timeself, storageRoot,
      kernelHead: cfg.kernelHead ?? null,
      bootId: cfg.bootId ?? null,
      processId: cfg.processId ?? process.pid,
      hostname: cfg.hostname ?? null,
    });
    instance.started_monotonic_ms = timeself.monotonicNow();
    const lock = await acquireRuntimeLock(storageRoot, timeself, instance, { livenessVerifier });
    if (!lock.ok) return lock;
    // 4. STARTING record.
    const starting = await setStatus(RUNTIME_STATUSES.STARTING);
    if (!starting.ok) return starting;
    // 5–13. recovery (RECOVERING witness written first — step 14 in spirit).
    await setStatus(RUNTIME_STATUSES.RECOVERING);
    recovery = await runStartupRecovery(storageRoot, timeself, { runtimeInstanceId: instance.runtime_instance_id });
    // 15–16. readiness.
    const health = await computeHealth(storageRoot, timeself, instance);
    readiness = computeReadiness(health, recovery);
    const next = readiness.ready
      ? RUNTIME_STATUSES.READY
      : RUNTIME_STATUSES.DEGRADED;
    await setStatus(next, { readiness_reasons: readiness.reasons, degraded: recovery.degraded === true });
    return { ok: true, status: next, readiness, recovery, instance };
  }

  /**
   * One deterministic service-loop pass: lease at most one eligible item from
   * the safe queues, dispatch its worker, persist the outcome before returning.
   */
  async function tick() {
    if (draining) return fail(ERR.ORCHESTRATOR_DRAINING, 'no lease acquisition after DRAINING');
    if (status !== RUNTIME_STATUSES.READY && status !== RUNTIME_STATUSES.DEGRADED) {
      return fail(ERR.ORCHESTRATOR_NOT_READY, `loop requires READY or DEGRADED (status: ${status})`);
    }
    await heartbeatRuntimeLock(storageRoot, timeself, instance);

    for (const queueName of SAFE_CONSUMED_QUEUES) {
      const listed = await listQueueItems(storageRoot, queueName);
      if (!listed.ok) continue;

      // Retry scheduling: dead-letter terminal failures, then re-queue eligible
      // SAFE_AUTOMATIC retryables.
      for (const item of listed.items) {
        if (item.state === QUEUE_STATES.FAILED_FINAL) {
          await deadLetterQueueItem(storageRoot, timeself, {
            queueName, queueItemId: item.queue_item_id,
            terminalReason: item.last_error ?? 'terminal failure',
            requiredHumanAction: 'HUMAN-TURN review of terminally failed work',
            runtimeInstanceId: instance.runtime_instance_id,
          });
          continue;
        }
        if (item.state === QUEUE_STATES.FAILED_RETRYABLE && item.retry_class === RETRY_CLASSES.SAFE_AUTOMATIC && timeself.isEligible(item)) {
          if (item.attempt_count >= item.maximum_attempts) {
            await deadLetterQueueItem(storageRoot, timeself, {
              queueName, queueItemId: item.queue_item_id,
              terminalReason: 'retry attempts exhausted',
              requiredHumanAction: 'HUMAN-TURN review of exhausted safe work',
              runtimeInstanceId: instance.runtime_instance_id,
            });
          } else {
            await requeueRetryableItem(storageRoot, timeself, { queueName, queueItemId: item.queue_item_id, runtimeInstanceId: instance.runtime_instance_id });
          }
        }
      }

      const refreshed = await listQueueItems(storageRoot, queueName);
      const candidate = refreshed.items.find((i) => i.state === QUEUE_STATES.QUEUED && timeself.isEligible(i) && !timeself.isExpired(i));
      if (!candidate) continue;

      const workerKind = CONSUMER_TO_WORKER[candidate.intended_consumer_self];
      if (!workerKind) {
        // Unsupported/unknown consumer on a safe queue: NEVER-class fail-closed.
        await deadLetterQueueItem(storageRoot, timeself, {
          queueName, queueItemId: candidate.queue_item_id,
          terminalReason: `unsupported consumer: ${candidate.intended_consumer_self}`,
          requiredHumanAction: 'HUMAN-TURN review of unsupported queue item',
          runtimeInstanceId: instance.runtime_instance_id,
        });
        return { ok: true, worked: false, dead_lettered: candidate.queue_item_id };
      }

      const workerId = `${workerKind}-worker@${instance.runtime_instance_id}`;
      const leased = await leaseQueueItem(storageRoot, timeself, {
        queueName, queueItemId: candidate.queue_item_id,
        workerId, runtimeInstanceId: instance.runtime_instance_id, leaseDurationMs,
      });
      if (!leased.ok) continue; // lost the race — deterministic loser behavior

      const lease = leased.item.lease;
      try {
        const result = await WORKERS[workerKind](leased.item);
        // Worker completion persists BEFORE the loop can lease anything else.
        const completed = await completeQueueItem(storageRoot, timeself, {
          queueName, queueItemId: candidate.queue_item_id,
          workerId, leaseId: lease.lease_id, result,
        });
        return { ok: true, worked: true, queue_name: queueName, queue_item_id: candidate.queue_item_id, worker: workerKind, result, completed: completed.ok };
      } catch (err) {
        const failed = await failQueueItem(storageRoot, timeself, {
          queueName, queueItemId: candidate.queue_item_id,
          workerId, leaseId: lease.lease_id,
          errorMessage: String(err && err.message || err),
        });
        // NEVER / exhausted HUMAN_REQUIRED shapes surface via FAILED_FINAL;
        // dead-letter routing for review happens on a later pass or explicitly.
        return { ok: true, worked: true, failed: true, queue_name: queueName, queue_item_id: candidate.queue_item_id, failure_state: failed.ok ? failed.item.state : null };
      }
    }
    return { ok: true, worked: false };
  }

  /** Graceful shutdown: DRAIN → STOPPING → STOPPED witness → lawful lock release. */
  async function shutdown() {
    draining = true;
    await setStatus(RUNTIME_STATUSES.DRAINING);
    // tick() is synchronous per pass, so no in-flight work survives here;
    // leases already persisted stay intact per item policy.
    await setStatus(RUNTIME_STATUSES.STOPPING);
    await setStatus(RUNTIME_STATUSES.STOPPED);
    await appendGlobalEvent(storageRoot, {
      event_version: 'ourself.runtime-event.v1',
      type: 'RUNTIME_STOPPED_WITNESS',
      runtime_instance_id: instance.runtime_instance_id,
      final_heartbeat_at: instance.last_heartbeat_at,
      at: timeself.now(),
    });
    const released = await releaseRuntimeLock(storageRoot, timeself, instance, { shutdownLawful: true });
    return { ok: true, status, released: released.ok, release_error: released.ok ? null : released.error };
  }

  return {
    orchestrator_version: ORCHESTRATOR_VERSION,
    start,
    tick,
    shutdown,
    getInstance: () => instance,
    getStatus: () => status,
    getReadiness: () => readiness,
    getRecovery: () => recovery,
  };
}

export { RUNTIME_SELF_ERRORS };
