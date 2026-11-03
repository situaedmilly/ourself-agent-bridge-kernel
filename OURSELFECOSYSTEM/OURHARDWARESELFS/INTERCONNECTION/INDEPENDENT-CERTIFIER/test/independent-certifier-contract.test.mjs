import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const profile = JSON.parse(readFileSync(new URL('independent-certifier-profile.v0.1.json', root)));
const schema = JSON.parse(readFileSync(new URL('contracts/independent-certifier-binding.schema.v0.1.json', root)));

test('certifier remains explicitly unprovisioned', () => {
  assert.equal(profile.status, 'ENGINEERED_HOST_BINDING_UNRESOLVED');
  assert.equal(profile.rootKey.exists, false);
  assert.equal(profile.rootKey.generated, false);
  assert.equal(profile.selectedTrustDomain, null);
  assert.equal(profile.currentDisposition.certifierOperational, false);
  assert.equal(profile.currentDisposition.trustBundleSigned, false);
});

test('root purposes exclude operational PORTAL admission', () => {
  assert.deepEqual(profile.permittedSigningPurposes, [
    'ENDPOINT_CERTIFICATE_ISSUANCE',
    'INPUTSELFTRUSTSELF_BUNDLE_SIGNATURE'
  ]);
  assert.ok(profile.prohibitedSigningPurposes.includes('PORTAL_OPERATION_ADMISSION'));
});

test('C10 subject is pinned and SELFSERVER-2 excluded', () => {
  assert.equal(profile.workloadScope.commit, '3fdde73c099f9b99814d72dc224c638965be27e9');
  assert.equal(profile.workloadScope.sha256, '22a4228da535aab04fb653b19f07d71fc81d3305fc9a0db398a2e6acfc717c5f');
  assert.ok(profile.exclusions.includes('SELFSERVER-2'));
});

test('schema forbids private key material and endpoint self-certification', () => {
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.privateKeyMaterial.const, null);
  assert.ok(schema.properties.endpointHostIds.not.contains.enum.includes('HW-OURSELFMAC-001'));
  assert.ok(schema.properties.endpointHostIds.not.contains.enum.includes('HW-OURSELFPIMAC-001'));
  assert.equal(schema.properties.custodyBoundary.properties.privateKeyNonExportableOrOffline.const, true);
});

test('identity-verified and bound states require a non-null structured substrate identity', () => {
  const identity = schema.properties.substrateIdentity;
  assert.equal(identity.type, 'object');
  assert.equal(identity.additionalProperties, false);
  for (const field of ['immutableIdentity', 'identityType', 'evidenceRef']) {
    assert.ok(identity.required.includes(field));
  }
  const gate = schema.allOf.find(x => x.if?.properties?.status?.enum?.includes('IDENTITY_VERIFIED') &&
    x.if.properties.status.enum.length === 2);
  assert.ok(gate);
  assert.ok(gate.if.required.includes('status'));
  assert.ok(gate.then.required.includes('substrateIdentity'));
});

test('BOUND does not demand a root key before KEY_GENERATED', () => {
  assert.equal(schema.properties.rootKeyId, undefined);
  assert.equal(schema.properties.publicKeyFingerprint, undefined);
  const boundGate = schema.allOf.find(x => x.if?.properties?.status?.const === 'BOUND');
  assert.deepEqual(boundGate.then.required, [
    'jurisdictionEvidenceRefs',
    'custodyBoundary',
    'auditRecontact'
  ]);
});

test('evidence requirements advance with the binding state', () => {
  assert.deepEqual(schema.required, ['certifierId', 'trustDomainId', 'substrateType', 'status']);
  const discoveredGate = schema.allOf.find(x =>
    x.if?.properties?.status?.enum?.includes('DISCOVERED') &&
    x.if.properties.status.enum.includes('BOUND'));
  assert.ok(discoveredGate);
  assert.deepEqual(discoveredGate.then.required, ['identityEvidenceRefs']);
  const verifiedGate = schema.allOf.find(x =>
    x.if?.properties?.status?.enum?.includes('IDENTITY_VERIFIED') &&
    x.if.properties.status.enum.length === 2);
  assert.ok(verifiedGate);
  assert.deepEqual(verifiedGate.then.required, ['substrateIdentity']);
});
