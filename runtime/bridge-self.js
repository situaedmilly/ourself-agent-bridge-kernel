// runtime/bridge-self.js
// ── T-034: BridgeSELF — validated queue admission and routing jurisdiction ──
//
// PURPOSE
//   Convert durable, integrity-verified proposal-plane state into declared
//   queue items: which queue, which intended consumer, which retry class —
//   and nothing else.
//
// FOUNDATIONAL LAW
//   BRIDGESELF ≠ EXECUTION. BridgeSELF owns validated queue admission,
//   routing, queue-to-worker matching, correlation propagation, dead-letter
//   routing, and routing evidence. BridgeSELF never interprets free-form
//   intent, never authorizes, never executes proposals, never alters
//   HUMAN-TURN decisions, never determines truth, never performs model
//   reasoning, and never mutates governance files.
//
//   AUTHORIZED ≠ AUTOMATICALLY EXECUTED: an authorized proposal routes to the
//   execution queue as HUMAN_REQUIRED display-only work. No T-034 worker
//   consumes it. Actual consumption remains manual or a future explicitly
//   governed workflow.

'use strict';

import {
  getPendingProposal,
  verifyPendingProposal,
} from '../persistence/pending-proposals.js';
import { enqueueQueueItem, RETRY_CLASSES } from '../persistence/queue-store.js';

export const BRIDGE_SELF_VERSION = 'ourself.bridge-self.v1';

export const BRIDGE_SELF_ERRORS = Object.freeze({
  UNSUPPORTED_ITEM_TYPE: 'UNSUPPORTED_ITEM_TYPE',
  ROUTING_STATE_MISMATCH: 'ROUTING_STATE_MISMATCH',
  ROUTING_AUTHORITY_INVALID: 'ROUTING_AUTHORITY_INVALID',
  ROUTING_INTEGRITY_FAILURE: 'ROUTING_INTEGRITY_FAILURE',
  ROUTING_PARENT_EVENT_MISMATCH: 'ROUTING_PARENT_EVENT_MISMATCH',
  ROUTING_CONSUMER_MISMATCH: 'ROUTING_CONSUMER_MISMATCH',
});

const ERR = BRIDGE_SELF_ERRORS;

// Frozen routing table: item type → target queue, intended consumer, retry
// class, and the durable proposal states that lawfully produce it. This table
// is the ONLY source of routes; free-form intent plays no role.
export const ROUTING_TABLE = Object.freeze({
  'persisted-proposal-awaiting-decision': Object.freeze({
    queue: 'human-decision',
    consumer: 'HUMAN-TURN',
    retry_class: RETRY_CLASSES.HUMAN_REQUIRED,
    allowed_states: Object.freeze(['PERSISTED_PENDING']),
    required_last_event: 'PROPOSAL_PERSISTED',
  }),
  'authorized-proposal-pending-execution': Object.freeze({
    queue: 'execution',
    consumer: 'HUMAN-TURN', // display-only in T-034: never machine-consumed
    retry_class: RETRY_CLASSES.HUMAN_REQUIRED,
    allowed_states: Object.freeze(['AUTHORIZED_PENDING_EXECUTION']),
    required_last_event: 'PROPOSAL_AUTHORIZED',
  }),
  'execution-terminal-without-witness': Object.freeze({
    queue: 'witness',
    consumer: 'witness-worker',
    retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
    allowed_states: Object.freeze(['EXECUTION_COMPLETED', 'EXECUTION_FAILED']),
    required_last_event: null,
  }),
  'witness-without-reconciliation': Object.freeze({
    queue: 'reconciliation',
    consumer: 'reconciliation-worker',
    retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
    allowed_states: Object.freeze(['EXECUTION_COMPLETED', 'EXECUTION_FAILED']),
    required_last_event: 'WITNESS_CAPTURED',
  }),
  'reconciled-causal-unit': Object.freeze({
    queue: 'memory-update',
    consumer: 'memory-worker',
    retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
    allowed_states: Object.freeze(['EXECUTION_COMPLETED', 'EXECUTION_FAILED']),
    required_last_event: null,
  }),
  'runtime-health-probe': Object.freeze({
    queue: 'runtime-control',
    consumer: 'health-worker',
    retry_class: RETRY_CLASSES.SAFE_AUTOMATIC,
    allowed_states: null, // not proposal-derived
    required_last_event: null,
  }),
});

function fail(error, message) {
  return { ok: false, error, message: message || error };
}

/**
 * Pure route derivation from a durable proposal record. Decides which single
 * item type (if any) the record's CURRENT causal position lawfully produces.
 * Returns { ok, item_type, route } or a fail-closed verdict. No I/O.
 */
export function deriveRouteForRecord(record) {
  if (!record || typeof record !== 'object') {
    return fail(ERR.ROUTING_INTEGRITY_FAILURE, 'no record');
  }
  // A rejected proposal never routes anywhere — above all, never to execution.
  if (record.state === 'REJECTED_FINAL') {
    return { ok: true, item_type: null, route: null, reason: 'rejected-final-never-routes' };
  }
  let itemType = null;
  if (record.state === 'PERSISTED_PENDING') {
    itemType = 'persisted-proposal-awaiting-decision';
  } else if (record.state === 'AUTHORIZED_PENDING_EXECUTION') {
    if (record.authority?.decision_state !== 'AUTHORIZED') {
      return fail(ERR.ROUTING_AUTHORITY_INVALID, 'state says authorized but authority block disagrees');
    }
    itemType = 'authorized-proposal-pending-execution';
  } else if (record.state === 'EXECUTION_COMPLETED' || record.state === 'EXECUTION_FAILED') {
    if (record.reconciliation) itemType = 'reconciled-causal-unit';
    else if (record.witness) itemType = 'witness-without-reconciliation';
    else itemType = 'execution-terminal-without-witness';
  } else {
    return fail(ERR.ROUTING_STATE_MISMATCH, `no lawful route for state ${record.state}`);
  }
  const route = ROUTING_TABLE[itemType];
  if (!route) return fail(ERR.UNSUPPORTED_ITEM_TYPE, itemType);
  if (route.allowed_states && !route.allowed_states.includes(record.state)) {
    return fail(ERR.ROUTING_STATE_MISMATCH, `state ${record.state} cannot produce ${itemType}`);
  }
  if (route.required_last_event) {
    const events = Array.isArray(record.events) ? record.events : [];
    const last = events[events.length - 1];
    if (!last || last.type !== route.required_last_event) {
      return fail(ERR.ROUTING_PARENT_EVENT_MISMATCH, `expected last event ${route.required_last_event}, found ${last ? last.type : 'none'}`);
    }
  }
  return { ok: true, item_type: itemType, route };
}

/**
 * Validate an already-shaped queue-item spec against the routing table.
 * Fails closed on unsupported type, wrong queue, or wrong consumer.
 */
export function validateRoutedSpec(spec) {
  const route = ROUTING_TABLE[spec?.item_type];
  if (!route) return fail(ERR.UNSUPPORTED_ITEM_TYPE, `unsupported item type: ${spec?.item_type}`);
  if (spec.queue_name !== route.queue) return fail(ERR.ROUTING_STATE_MISMATCH, `item type ${spec.item_type} must route to ${route.queue}`);
  if (spec.intended_consumer_self !== route.consumer) return fail(ERR.ROUTING_CONSUMER_MISMATCH, `item type ${spec.item_type} must target consumer ${route.consumer}`);
  if (spec.retry_class !== route.retry_class) return fail(ERR.ROUTING_CONSUMER_MISMATCH, `item type ${spec.item_type} carries retry class ${route.retry_class}`);
  return { ok: true, route };
}

/**
 * Route one durable proposal into its lawful queue item and enqueue it.
 * Verifies record integrity FIRST — corrupted authority never routes.
 * Creates no authority, invokes no worker, executes nothing.
 */
export async function routeProposalRecord(storageRoot, timeself, { proposalId, runtimeInstanceId }) {
  const integrity = await verifyPendingProposal(storageRoot, proposalId);
  if (!integrity.ok) return integrity;
  if (integrity.valid === false) {
    return fail(ERR.ROUTING_INTEGRITY_FAILURE, `corrupted record never routes: ${JSON.stringify(integrity.details)}`);
  }
  const got = await getPendingProposal(storageRoot, proposalId);
  if (!got.ok) return got;
  const record = got.record;

  const derived = deriveRouteForRecord(record);
  if (!derived.ok) return derived;
  if (derived.item_type === null) {
    return { ok: true, routed: false, reason: derived.reason, proposal_id: proposalId };
  }
  const { item_type, route } = derived;
  const lastEvent = record.events[record.events.length - 1];

  const spec = {
    queue_item_id: `qi-${item_type}-${proposalId}`,
    queue_name: route.queue,
    item_type,
    producer_self: 'BridgeSELF',
    intended_consumer_self: route.consumer,
    correlation_id: proposalId,
    parent_event_hash: lastEvent?.event_hash ?? null,
    authority_state: record.authority?.decision_state ?? null,
    payload: {
      proposal_id: proposalId,
      record_hash: record.integrity.record_hash,
      semantic_checksum: record.semantic_checksum,
      state: record.state,
    },
    retry_class: route.retry_class,
    maximum_attempts: route.retry_class === RETRY_CLASSES.SAFE_AUTOMATIC ? 3 : 1,
    runtime_instance_id: runtimeInstanceId ?? null,
  };
  const specCheck = validateRoutedSpec(spec);
  if (!specCheck.ok) return specCheck;

  const enq = await enqueueQueueItem(storageRoot, timeself, spec);
  if (!enq.ok) return enq;
  return { ok: true, routed: true, idempotent: enq.idempotent, item_type, queue_name: route.queue, item: enq.item, proposal_id: proposalId };
}
