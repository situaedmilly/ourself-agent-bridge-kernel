import test from 'node:test';
import assert from 'node:assert/strict';

import { createCommunicationFabric } from '../runtime/communication-fabric.js';
import { createLoopbackAdapter } from '../runtime/loopback-adapter.js';
import { createBoundedAlternateAdapter, R2_ADAPTER_VERSION } from '../runtime/bounded-alternate-adapter.js';

function event(overrides = {}) {
  return {
    event_id: 'R2-EVT-001',
    event_type: 'SELF_COMMUNICATION',
    source: 'SELF_A',
    target: 'SELF_B',
    status: 'PROPOSED',
    relation: { species: 'communication', correlation_id: 'R2-CORR-001' },
    authority: { state: 'PENDING_HUMAN_TURN' },
    matter: { body: 'R2 transport substitution' },
    ...overrides,
  };
}

test('R2 alternate adapter satisfies the same fabric seam', async () => {
  const adapter = createBoundedAlternateAdapter();
  const fabric = createCommunicationFabric(adapter);
  assert.equal(adapter.version, R2_ADAPTER_VERSION);
  assert.equal(adapter.transport, 'bounded-alt');

  const original = event();
  const receipt = await fabric.send(original);
  const received = await fabric.receive();

  assert.equal(receipt.transport, 'bounded-alt');
  assert.equal(receipt.transport_authority, 'NONE');
  assert.deepEqual(received, original);
});

test('R2 preserves semantic invariants across two different transports', async () => {
  const original = event({
    relation: { species: 'communication', correlation_id: 'R2-CORR-002', in_reply_to: 'M1' },
  });
  const loopback = createCommunicationFabric(createLoopbackAdapter());
  const alternate = createCommunicationFabric(createBoundedAlternateAdapter());

  const loopReceipt = await loopback.send(original);
  const altReceipt = await alternate.send(original);
  const loopEvent = await loopback.receive();
  const altEvent = await alternate.receive();

  assert.deepEqual(loopEvent, original);
  assert.deepEqual(altEvent, original);
  assert.equal(loopEvent.event_id, altEvent.event_id);
  assert.equal(loopEvent.source, altEvent.source);
  assert.equal(loopEvent.target, altEvent.target);
  assert.deepEqual(loopEvent.relation, altEvent.relation);
  assert.deepEqual(loopEvent.authority, altEvent.authority);

  assert.notEqual(loopReceipt.transport, altReceipt.transport);
  assert.equal(loopReceipt.event_id, altReceipt.event_id);
  assert.equal(loopReceipt.transport_authority, 'NONE');
  assert.equal(altReceipt.transport_authority, 'NONE');
});

test('R2 alternate transport has no semantic admission or authority API', () => {
  const adapter = createBoundedAlternateAdapter();
  assert.equal(adapter.authorize, undefined);
  assert.equal(adapter.admit, undefined);
  assert.equal(adapter.execute, undefined);
  assert.equal(adapter.applyEffect, undefined);
});
