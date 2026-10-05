'use strict';

import { randomUUID } from 'node:crypto';

export const R2_ADAPTER_VERSION = 'ourself.r2.bounded-alt-transport.v0.1';

function assertEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.event_id !== 'string' || event.event_id.length === 0) {
    throw new TypeError('INVALID_EVENT');
  }
  return event;
}

// Second bounded transport. Deliberately uses a different internal
// representation so R2 proves the fabric, not queue implementation, is the seam.
export function createBoundedAlternateAdapter() {
  const storage = new Map();
  const order = [];

  return Object.freeze({
    version: R2_ADAPTER_VERSION,
    transport: 'bounded-alt',
    async send(event) {
      const semanticEvent = assertEvent(event);
      const delivery_id = randomUUID();
      storage.set(delivery_id, semanticEvent);
      order.push(delivery_id);
      return Object.freeze({
        receipt_version: 'ourself.transport-receipt.v0.1',
        receipt_id: delivery_id,
        transport: 'bounded-alt',
        event_id: semanticEvent.event_id,
        status: 'DELIVERED_TO_BOUNDED_STORE',
        transport_authority: 'NONE',
      });
    },
    async receive() {
      const delivery_id = order.shift();
      return delivery_id === undefined ? null : storage.get(delivery_id);
    },
    size() {
      return order.length;
    },
  });
}
