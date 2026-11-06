import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMUNICATION_FABRIC_VERSION, createCommunicationFabric } from '../runtime/communication-fabric.js';
import { createLoopbackAdapter, LOOPBACK_ADAPTER_VERSION } from '../runtime/loopback-adapter.js';

function event(overrides = {}) {
  return { event_id:'EVT-LOOPBACK-001', event_type:'SELF_COMMUNICATION', source:'SELF_A', target:'SELF_B', status:'PROPOSED', relation:{species:'communication',correlation_id:'CORR-001'}, authority:{state:'PENDING_HUMAN_TURN'}, matter:{body:'transport substitution test'}, ...overrides };
}

test('exports runtime membrane versions', () => {
  assert.equal(COMMUNICATION_FABRIC_VERSION, 'ourself.communication-fabric.v0.1');
  assert.equal(LOOPBACK_ADAPTER_VERSION, 'ourself.loopback-adapter.v0.1');
});

test('fabric rejects adapter without send and receive', () => {
  assert.throws(() => createCommunicationFabric({ send() {} }), /INVALID_ADAPTER/);
});

test('loopback send produces transport-scoped receipt', async () => {
  const adapter=createLoopbackAdapter(); const fabric=createCommunicationFabric(adapter); const receipt=await fabric.send(event());
  assert.equal(receipt.transport,'loopback'); assert.equal(receipt.status,'DELIVERED_TO_BOUNDED_QUEUE'); assert.equal(receipt.event_id,'EVT-LOOPBACK-001'); assert.equal(receipt.transport_authority,'NONE'); assert.equal(adapter.size(),1);
});

test('semantic event crosses transport unchanged', async () => {
  const original=event(); const fabric=createCommunicationFabric(createLoopbackAdapter()); await fabric.send(original); const received=await fabric.receive();
  assert.deepEqual(received,original); assert.equal(received.source,'SELF_A'); assert.equal(received.target,'SELF_B'); assert.equal(received.authority.state,'PENDING_HUMAN_TURN'); assert.equal(received.relation.correlation_id,'CORR-001');
});

test('empty loopback receives null', async () => { assert.equal(await createCommunicationFabric(createLoopbackAdapter()).receive(),null); });

test('bounded loopback rejects overflow without dropping queued events', async () => {
  const adapter=createLoopbackAdapter({maxQueueDepth:1}); const fabric=createCommunicationFabric(adapter); await fabric.send(event());
  await assert.rejects(fabric.send(event({event_id:'EVT-LOOPBACK-002'})),/QUEUE_FULL/); assert.equal(adapter.size(),1); assert.equal((await fabric.receive()).event_id,'EVT-LOOPBACK-001');
});

test('fabric does not mutate semantic event during send', async () => {
  const original=event(); const before=structuredClone(original); await createCommunicationFabric(createLoopbackAdapter()).send(original); assert.deepEqual(original,before);
});

test('request response preserves correlation and identity', async () => {
  const fabric=createCommunicationFabric(createLoopbackAdapter());
  const request=event({event_id:'M1'}); const response=event({event_id:'M2',source:'SELF_B',target:'SELF_A',relation:{species:'communication',correlation_id:'CORR-001',in_reply_to:'M1'}});
  await fabric.send(request); assert.deepEqual(await fabric.receive(),request); await fabric.send(response); const received=await fabric.receive();
  assert.deepEqual(received,response); assert.equal(received.relation.in_reply_to,'M1'); assert.equal(received.source,'SELF_B'); assert.equal(received.target,'SELF_A');
});

test('transport receipt is not a semantic event', async () => {
  const receipt=await createCommunicationFabric(createLoopbackAdapter()).send(event());
  assert.equal(receipt.transport,'loopback'); assert.equal(receipt.transport_authority,'NONE'); assert.equal(receipt.event_type,undefined); assert.equal(receipt.authority,undefined);
});

test('loopback is bounded and local', () => {
  const adapter=createLoopbackAdapter(); assert.equal(adapter.transport,'loopback'); assert.equal(adapter.maxQueueDepth,64); assert.equal(typeof adapter.send,'function'); assert.equal(typeof adapter.receive,'function');
});
