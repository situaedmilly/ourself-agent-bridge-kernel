// runtime/health.js
// ── T-034: Health and readiness — deterministic, read-only, no network ──────
//
// PURPOSE
//   Compute the runtime's health snapshot and readiness verdict as pure
//   library functions over durable state. No HTTP route exists or may exist
//   under this gate: health is library output and CLI proof text only.
//
//   A degraded runtime may be healthy but not ready.

'use strict';

import { lstat } from 'node:fs/promises';
import { verifyEventLedger } from '../persistence/pending-proposals.js';
import { listQueueItems, classifyExpiredLease, QUEUE_NAMES, QUEUE_STATES, RETRY_CLASSES } from '../persistence/queue-store.js';
import { getRuntimeLock } from './runtime-self.js';

export const HEALTH_VERSION = 'ourself.runtime-health.v1';

/** Read-only health snapshot over durable state. Never mutates anything. */
export async function computeHealth(storageRoot, timeself, instance) {
  const health = {
    health_version: HEALTH_VERSION,
    computed_at: timeself.now(),
    process_alive: true,
    runtime_instance_id: instance?.runtime_instance_id ?? null,
    runtime_status: instance?.status ?? null,
    kernel_git_head: instance?.kernel_git_head ?? null,
    uptime_ms: instance?.started_monotonic_ms !== undefined ? timeself.elapsedMs(instance.started_monotonic_ms) : null,
    last_heartbeat_at: instance?.last_heartbeat_at ?? null,
    lock_owned: false,
    lock_valid: false,
    storage_reachable: false,
    ledger_valid: false,
    queue_counts: {},
    corrupted_item_counts: {},
    expired_lease_count: 0,
    unknown_consequential_lease_count: 0,
    dead_letter_count: 0,
  };

  try {
    const st = await lstat(storageRoot);
    health.storage_reachable = st.isDirectory();
  } catch {
    health.storage_reachable = false;
  }
  if (!health.storage_reachable) return health;

  const lock = await getRuntimeLock(storageRoot);
  health.lock_valid = lock.locked && lock.valid;
  health.lock_owned = health.lock_valid && lock.lock.runtime_instance_id === instance?.runtime_instance_id;

  const ledger = await verifyEventLedger(storageRoot);
  health.ledger_valid = ledger.valid === true;

  for (const queueName of QUEUE_NAMES) {
    const listed = await listQueueItems(storageRoot, queueName);
    if (!listed.ok) continue;
    health.queue_counts[queueName] = listed.items.length;
    health.corrupted_item_counts[queueName] = listed.corrupted.length;
    for (const item of listed.items) {
      if (item.state === QUEUE_STATES.LEASED) {
        const cls = classifyExpiredLease(item, timeself);
        if (cls.expired) {
          health.expired_lease_count += 1;
          if (item.retry_class !== RETRY_CLASSES.SAFE_AUTOMATIC) {
            health.unknown_consequential_lease_count += 1;
          }
        }
      }
    }
    if (queueName === 'dead-letter') health.dead_letter_count = listed.items.length;
  }
  return health;
}

/**
 * Readiness law. False whenever: ledger invalid; lock invalid/unowned;
 * storage boundary invalid; recovery incomplete or blocked; an unknown
 * consequential lease exists; or configuration is invalid.
 */
export function computeReadiness(health, recovery, { configValid = true } = {}) {
  const reasons = [];
  if (!configValid) reasons.push('configuration_invalid');
  if (!health.storage_reachable) reasons.push('storage_unreachable');
  if (!health.ledger_valid) reasons.push('event_ledger_invalid');
  if (!health.lock_valid || !health.lock_owned) reasons.push('runtime_lock_not_owned');
  if (!recovery || recovery.ok !== true) reasons.push('recovery_incomplete');
  else if (recovery.ready_permitted !== true) reasons.push(`recovery_blocked:${recovery.reason}`);
  if (health.unknown_consequential_lease_count > 0) reasons.push('unknown_consequential_lease');
  return { ready: reasons.length === 0, reasons };
}
