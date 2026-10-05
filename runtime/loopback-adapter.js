'use strict';

import { randomUUID } from 'node:crypto';

export const LOOPBACK_ADAPTER_VERSION = 'ourself.loopback-adapter.v0.1';
export const DEFAULT_MAX_QUEUE_DEPTH = 64;
export const LOOPBACK_RECEIPT_VERSION = 'ourself.transport-receipt.v0.1';
export const LOOPBACK_ERRORS = Object.freeze({ QUEUE_FULL:'QUEUE_FULL', INVALID_EVENT:'INVALID_EVENT' });

function assertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.event_id !== 'string' || event.event_id.length === 0) throw new TypeError(LOOPBACK_ERRORS.INVALID_EVENT);
  return event;
}

// Deterministic bounded local transport. No filesystem, network, subprocess, or external service.
export function createLoopbackAdapter(options = {}) {
  const maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
  if (!Number.isInteger(maxQueueDepth) || maxQueueDepth < 1) throw new RangeError('maxQueueDepth must be a positive integer');
  const queue = [];
  return Object.freeze({
    version: LOOPBACK_ADAPTER_VERSION,
    transport: 'loopback',
    maxQueueDepth,
    async send(event) {
      const semanticEvent = assertEvent(event);
      if (queue.length >= maxQueueDepth) throw new Error(LOOPBACK_ERRORS.QUEUE_FULL);
      queue.push(semanticEvent);
      return Object.freeze({ receipt_version:LOOPBACK_RECEIPT_VERSION, receipt_id:randomUUID(), transport:'loopback', event_id:semanticEvent.event_id, status:'DELIVERED_TO_BOUNDED_QUEUE', queue_depth:queue.length, transport_authority:'NONE' });
    },
    async receive() { return queue.length === 0 ? null : queue.shift(); },
    size() { return queue.length; },
  });
}
