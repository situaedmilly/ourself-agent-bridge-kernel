import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const intake = JSON.parse(readFileSync(new URL('contracts/candidate-intake.v0.1.schema.json', root)));
const review = JSON.parse(readFileSync(new URL('contracts/admission-review.v0.1.schema.json', root)));
const doc = readFileSync(new URL('CANDIDATE-INTAKE-GATE-v0.1.md', root), 'utf8');

test('intake envelope requires every candidate evidence domain and is RECEIVED-only', () => {
  for (const field of ['candidateId','trustDomainId','substrateIdentity','administrativeControlEvidence','jurisdictionEvidence','custodyEvidence','auditEvidence','independentRecontact','evidenceDigests','admissionStatus']) {
    assert.ok(intake.required.includes(field), field);
  }
  assert.deepEqual(intake.properties.admissionStatus, { const: 'RECEIVED' });
});

test('candidate submission cannot self-assert verified or bound evidence', () => {
  for (const field of ['administrativeControlEvidence','jurisdictionEvidence','custodyEvidence','auditEvidence','independentRecontact']) {
    assert.deepEqual(intake.$defs.submissionEvidence.properties.submissionState.enum, ['MISSING','SUBMITTED']);
  }
  assert.equal(intake.$defs.evidenceDigest.properties.algorithm.const, 'SHA-256');
  assert.match(intake.$defs.evidenceDigest.properties.digest.pattern, /64/);
});

test('reviewer contract requires an external identity and separation evidence', () => {
  for (const field of ['reviewerTrustDomainId','reviewerIdentityEvidenceRefs','administrativeSeparationEvidenceRefs','portalIssuerTrustDomainId','independentRecontactRef','reviewerRole']) {
    assert.ok(review.$defs.reviewer.required.includes(field), field);
  }
  assert.ok(review.$defs.reviewer.properties.reviewerTrustDomainId.not.enum.includes('HW-OURSELFMAC-001'));
  assert.ok(review.$defs.reviewer.properties.reviewerTrustDomainId.not.enum.includes('HW-OURSELFPIMAC-001'));
});

test('BOUND requires a reviewer signature and every independent verification domain', () => {
  const gate = review.allOf.find(x => x.if?.properties?.admissionStatus?.const === 'BOUND');
  assert.ok(gate);
  assert.ok(gate.then.required.includes('reviewerSignature'));
  for (const field of ['reviewerIndependence','substrateIdentity','administrativeSeparation','jurisdiction','custody','recovery','auditIntegrity','independentRecontact']) {
    assert.equal(gate.then.properties.verification.properties[field].properties.status.const, 'VERIFIED', field);
  }
});

test('refusal states require a recorded refusal finding', () => {
  const gate = review.allOf.find(x => x.if?.properties?.admissionStatus?.enum?.includes('REFUSED_MISSING_EVIDENCE'));
  assert.ok(gate);
  assert.ok(gate.then.required.includes('refusal'));
  assert.ok(review.$defs.refusal.required.includes('reasonCode'));
});

test('intake contract preserves the no-provisioning and no-self-admission boundary', () => {
  assert.match(doc, /A BOUND decision only admits a candidate trust domain/i);
  assert.match(doc, /MUST NOT:[\s\S]*generate, import, export, or rotate a root key/i);
  assert.match(doc, /SELFSERVER-2: EXCLUDED/);
});

test('IDENTITY_VERIFIED requires verified identity and administrative separation', () => {
  const gate = review.allOf.find(x => x.if?.properties?.admissionStatus?.const === 'IDENTITY_VERIFIED');
  assert.ok(gate);
  assert.equal(gate.then.properties.verification.properties.substrateIdentity.properties.status.const, 'VERIFIED');
  assert.equal(gate.then.properties.verification.properties.administrativeSeparation.properties.status.const, 'VERIFIED');
});

test('every review decision is signed and refusal cannot be null', () => {
  assert.ok(review.required.includes('reviewerSignature'));
  const gate = review.allOf.find(x => x.if?.properties?.admissionStatus?.enum?.includes('REFUSED_MISSING_EVIDENCE'));
  assert.ok(gate.then.properties.refusal.$ref.endsWith('/refusal'));
});

test('reviewer independence is a verified gate before identity verification and BOUND', () => {
  assert.ok(review.$defs.verification.required.includes('reviewerIndependence'));
  for (const status of ['IDENTITY_VERIFIED', 'BOUND']) {
    const gate = review.allOf.find(x => x.if?.properties?.admissionStatus?.const === status);
    assert.equal(gate.then.properties.verification.properties.reviewerIndependence.properties.status.const, 'VERIFIED');
  }
  assert.ok(review.$defs.reviewer.required.includes('portalIssuerTrustDomainId'));
});
