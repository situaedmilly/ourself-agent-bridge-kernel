import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const profile = JSON.parse(readFileSync(new URL('independent-certifier-profile.v0.1.json', root)));
const schema = JSON.parse(readFileSync(new URL('contracts/independent-certifier-binding.schema.v0.1.json', root)));

test('certifier remains explicitly unprovisioned', () => {
 assert.equal(profile.status,'ENGINEERED_HOST_BINDING_UNRESOLVED');
 assert.equal(profile.rootKey.exists,false);
 assert.equal(profile.rootKey.generated,false);
 assert.equal(profile.selectedTrustDomain,null);
 assert.equal(profile.currentDisposition.certifierOperational,false);
 assert.equal(profile.currentDisposition.trustBundleSigned,false);
});
test('root purposes exclude operational PORTAL admission', () => {
 assert.deepEqual(profile.permittedSigningPurposes,['ENDPOINT_CERTIFICATE_ISSUANCE','INPUTSELFTRUSTSELF_BUNDLE_SIGNATURE']);
 assert.ok(profile.prohibitedSigningPurposes.includes('PORTAL_OPERATION_ADMISSION'));
});
test('C10 subject is pinned and SELFSERVER-2 excluded', () => {
 assert.equal(profile.workloadScope.commit,'3fdde73c099f9b99814d72dc224c638965be27e9');
 assert.equal(profile.workloadScope.sha256,'22a4228da535aab04fb653b19f07d71fc81d3305fc9a0db398a2e6acfc717c5f');
 assert.ok(profile.exclusions.includes('SELFSERVER-2'));
});
test('schema forbids private key material and endpoint self-certification', () => {
 assert.equal(schema.additionalProperties,false);
 assert.equal(schema.properties.privateKeyMaterial.const,null);
 assert.ok(schema.properties.endpointHostIds.not.contains.enum.includes('HW-OURSELFMAC-001'));
 assert.ok(schema.properties.endpointHostIds.not.contains.enum.includes('HW-OURSELFPIMAC-001'));
 assert.equal(schema.properties.custodyBoundary.properties.privateKeyNonExportableOrOffline.const,true);
});
test('binding requires identity, jurisdiction, custody and independent recontact evidence', () => {
 for (const field of ['identityEvidenceRefs','jurisdictionEvidenceRefs','custodyBoundary','auditRecontact','status']) assert.ok(schema.required.includes(field));
});
