// runtime/recovery.js
// ── T-034: Startup recovery — RESTARTED ≠ RECOVERED ─────────────────────────
//
// PURPOSE
//   Reconstruct lawful operating state from disk on every startup: verify the
//   ledger and authority stores, isolate corrupt queue items, classify
//   incomplete leases, and enqueue ONLY lawful non-consequential recovery
//   work (witness-without-reconciliation resume). Execution retry is never
//   enqueued. Recovery is idempotent: running it twice enqueues nothing new.

'use strict';

import { verifyEventLedger, listPendingProposals, verifyPendingProposal } from '../persistence/pending-proposals.js';
import { listQueueItems, classifyExpiredLease, QUEUE_NAMES, QUEUE_STATES } from '../persistence/queue-store.js';
import { routeProposalRecord, deriveRouteForRecord } from './bridge-self.js';

export const RECOVERY_VERSION = 'ourself.runtime-recovery.v1';

/**
 * Run the durable-state portion of the startup recovery order (steps 5–13).
 * Read-mostly: the only writes are lawful non-consequential queue admissions
 * through BridgeSELF. Never leases, never executes, never retries execution.
 */
export async function runStartupRecovery(storageRoot, timeself, { runtimeInstanceId }) {
  const findings = {
    recovery_version: RECOVERY_VERSION,
    ledger_valid: false,
    proposals_total: 0,
    proposals_corrupted: [],
    queue_counts: {},
    corrupted_queue_items: [],
    expired_leases: [],
    human_required_leases: [],
    reclaimable_leases: [],
    witness_resume_enqueued: [],
    execution_retries_enqueued: 0, // must remain 0 forever under T-034
    blocked_consequential_items: [],
  };

  // 5. Global ledger integrity.
  const ledger = await verifyEventLedger(storageRoot);
  findings.ledger_valid = ledger.valid === true;
  if (!findings.ledger_valid) {
    return { ok: true, ready_permitted: false, degraded: true, reason: 'event_ledger_invalid', findings };
  }

  // 6. Proposal (authority) stores.
  const listed = await listPendingProposals(storageRoot);
  findings.proposals_total = listed.proposals.length;
  findings.proposals_corrupted = listed.corrupted;
  for (const record of listed.proposals) {
    const integrity = await verifyPendingProposal(storageRoot, record.proposal_id);
    if (integrity.valid === false) {
      findings.proposals_corrupted.push({ proposal_id: record.proposal_id, details: integrity.details });
    }
  }

  // 7–8. Queue stores; isolate corrupt items (isolation = report, never repair).
  for (const queueName of QUEUE_NAMES) {
    const listedQueue = await listQueueItems(storageRoot, queueName);
    if (!listedQueue.ok) continue;
    findings.queue_counts[queueName] = listedQueue.items.length;
    for (const c of listedQueue.corrupted) {
      findings.corrupted_queue_items.push({ queue_name: queueName, ...c });
    }
    // 9–10. Incomplete leases: classify, never auto-act.
    for (const item of listedQueue.items) {
      if (item.state !== QUEUE_STATES.LEASED) continue;
      const cls = classifyExpiredLease(item, timeself);
      if (!cls.expired) continue;
      const entry = { queue_name: queueName, queue_item_id: item.queue_item_id, retry_class: item.retry_class, classification: cls.classification };
      findings.expired_leases.push(entry);
      if (cls.reclaimable) findings.reclaimable_leases.push(entry);
      else findings.human_required_leases.push(entry);
    }
    // Consequential work visible but never consumed.
    if (queueName === 'execution') {
      for (const item of listedQueue.items) {
        if (item.state === QUEUE_STATES.QUEUED || item.state === QUEUE_STATES.LEASED || item.state === QUEUE_STATES.FAILED_RETRYABLE) {
          findings.blocked_consequential_items.push({ queue_item_id: item.queue_item_id, state: item.state });
        }
      }
    }
  }

  // 11–13. Witness-without-reconciliation resume (lawful, non-consequential).
  // Execution retry is NEVER enqueued: deriveRouteForRecord can only produce
  // the display-only execution route for AUTHORIZED records, and recovery
  // filters routing to the safe post-execution item types below.
  const SAFE_RECOVERY_TYPES = new Set(['witness-without-reconciliation', 'execution-terminal-without-witness']);
  for (const record of listed.proposals) {
    if (record.reconciliation) continue;
    const derived = deriveRouteForRecord(record);
    if (!derived.ok || !derived.item_type || !SAFE_RECOVERY_TYPES.has(derived.item_type)) continue;
    const routed = await routeProposalRecord(storageRoot, timeself, { proposalId: record.proposal_id, runtimeInstanceId });
    if (routed.ok && routed.routed) {
      findings.witness_resume_enqueued.push({ proposal_id: record.proposal_id, item_type: routed.item_type, queue_name: routed.queue_name, idempotent: routed.idempotent === true });
    }
  }

  const degraded =
    findings.corrupted_queue_items.length > 0 ||
    findings.proposals_corrupted.length > 0;
  const readyBlocked =
    !findings.ledger_valid ||
    findings.human_required_leases.length > 0;

  return {
    ok: true,
    ready_permitted: !readyBlocked,
    degraded,
    reason: readyBlocked ? (findings.ledger_valid ? 'human_required_lease_outstanding' : 'event_ledger_invalid') : null,
    findings,
  };
}
