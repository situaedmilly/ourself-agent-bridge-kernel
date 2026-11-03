import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createIndependentAdmissionVerifier, canonicalize, sha256 } from '../independent-admission-verifier.v0.1.mjs';

const NOW = Date.parse('2026-11-03T20:00:00.000Z');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const runtimeKeys=generateKeyPairSync('ed25519');
const runtimeComponents=()=>Object.fromEntries(['admissionVerifier','evidenceResolver','identityResolver','signatureResolver','revocationChecker','receiptStore',
  ...[...keys,'reviewerIndependence'].map(x=>'domainVerifier:'+x)].map(id=>[id,{version:'0.1.0',artifactDigest:sha256('artifact:'+id),configDigest:sha256('config:'+id),adminBoundaryId:'verifier-admin'}]));
const policy = () => ({
  policyVersion:'candidate-intake-v0.1',
  endpointTrustDomainIds:['mac-domain','pi-domain'],
  portalTrustDomainIds:['portal-domain'],
  domainVerifierIds:{substrateIdentity:'trusted:substrateIdentity',administrativeSeparation:'trusted:administrativeSeparation',jurisdiction:'trusted:jurisdiction',custody:'trusted:custody',recovery:'trusted:recovery',auditIntegrity:'trusted:auditIntegrity',independentRecontact:'trusted:independentRecontact',reviewerIndependence:'trusted:reviewer-independence'},
  forbiddenAdminBoundaryIds:['mac-admin','pi-admin','portal-admin'],
  maxEvidenceAgeMs:7*24*60*60*1000,
  maxDecisionAgeMs:7*24*60*60*1000,
  maxClockSkewMs:30_000,
  verifierRuntime:{runtimeId:'independent-admission-verifier-runtime',version:'0.1.0',artifactDigest:sha256('artifact:runtime'),
    configDigest:sha256('config:runtime'),adminBoundaryId:'verifier-admin',attestationKeyId:'runtime-attestor-001',
    attestationPublicKey:runtimeKeys.publicKey.export({type:'spki',format:'pem'}),maxAttestationAgeMs:60_000,components:runtimeComponents()}
});
const keys = ['substrateIdentity','administrativeSeparation','jurisdiction','custody','recovery','auditIntegrity','independentRecontact'];
const reviewerEvidence = ['id:reviewer','admin:reviewer','recontact:reviewer','id:submitter','ev:admin'].sort();
const refs = {
  submitterIdentity:['id:submitter'],
  substrateIdentity:['ev:substrate'],
  administrativeSeparation:['ev:admin'],
  jurisdiction:['ev:jurisdiction'],
  custody:['ev:custody'],
  recovery:['ev:recovery'],
  auditIntegrity:['ev:audit'],
  independentRecontact:['ev:recontact']
};
const jsonBytes = value => Buffer.from(JSON.stringify(value));
const signDecision = decision => {
  const { reviewerSignature, ...payload } = decision;
  const payloadBytes = Buffer.from(canonicalize(payload));
  decision.reviewerSignature.signedPayloadDigest = sha256(payloadBytes);
  return sign(null,payloadBytes,privateKey);
};
async function fixture(options = {}) {
  const evidence = new Map();
  const evidenceDigests = [];
  const observedAt = new Date(NOW-60_000).toISOString();
  for (const ref of Object.values(refs).flat()) {
    const b=Buffer.from('evidence-bytes:' + ref);
    const sourceIdentity='source:' + ref;
    const mediaType='application/octet-stream';
    evidence.set(ref,{bytes:b,sourceIdentity,mediaType,observedAt,independentlyRetrieved:true,sourceAuthenticated:true});
    evidenceDigests.push({evidenceRef:ref,algorithm:'SHA-256',digest:sha256(b),mediaType,observedAt,sourceIdentity});
  }
  const intake={
    candidateId:'candidate-001',trustDomainId:'candidate-domain',
    submitterIdentity:'submitter-001',submitterTrustDomainId:'submitter-domain',
    submitterIdentityEvidenceRefs:['id:submitter'],
    substrateIdentity:{immutableIdentity:'candidate-device-001',identityType:'HARDWARE_ATTESTED_ID',evidenceRef:'ev:substrate'},
    administrativeControlEvidence:{submissionState:'SUBMITTED',evidenceRefs:refs.administrativeSeparation},
    jurisdictionEvidence:{submissionState:'SUBMITTED',evidenceRefs:refs.jurisdiction},
    custodyEvidence:{submissionState:'SUBMITTED',evidenceRefs:refs.custody},
    recoveryEvidence:{submissionState:'SUBMITTED',evidenceRefs:refs.recovery},
    auditEvidence:{submissionState:'SUBMITTED',evidenceRefs:refs.auditIntegrity},
    independentRecontact:{submissionState:'SUBMITTED',evidenceRefs:refs.independentRecontact},
    evidenceDigests,admissionStatus:'RECEIVED'
  };
  const intakeBytes=jsonBytes(intake), intakeDigest=sha256(intakeBytes);
  const reviewer={
    reviewerTrustDomainId:options.reviewerTrustDomainId ?? 'reviewer-domain',
    reviewerIdentityEvidenceRefs:['id:reviewer'],
    administrativeSeparationEvidenceRefs:['admin:reviewer'],
    portalIssuerTrustDomainId:'portal-domain',
    independentRecontactRef:'recontact:reviewer',
    reviewerRole:'INDEPENDENT_ADMISSION_REVIEWER'
  };
  for(const ref of ['id:reviewer','admin:reviewer','recontact:reviewer']){
    const b=Buffer.from('evidence-bytes:'+ref),sourceIdentity='source:'+ref,mediaType='application/octet-stream';
    evidence.set(ref,{bytes:b,sourceIdentity,mediaType,observedAt,independentlyRetrieved:true,sourceAuthenticated:true});
  }
  const makeChecks = state => {
    const result={};
    for (const key of ['reviewerIndependence',...keys]) {
      const verified = state === 'BOUND' || (state === 'IDENTITY_VERIFIED' && ['reviewerIndependence','substrateIdentity','administrativeSeparation'].includes(key));
      const evidenceRefs = key === 'reviewerIndependence' ? reviewerEvidence : refs[key];
      result[key]={status:verified?'VERIFIED':'PENDING',evidenceRefs};
    }
    return result;
  };
  const decisions=new Map(), signatures=new Map();
  const createDecision=(state,priorDigest,id) => {
    const decisionRef='ev:decision:'+id;
    const decisionEvidenceBytes=Buffer.from('decision-evidence-bytes:'+id);
    const decisionSource='source:'+decisionRef;
    const decisionMedia='application/octet-stream';
    evidence.set(decisionRef,{bytes:decisionEvidenceBytes,sourceIdentity:decisionSource,mediaType:decisionMedia,observedAt,independentlyRetrieved:true,sourceAuthenticated:true});
    const d={
      reviewId:id,intakeReceiptId:'intake-receipt-001',intakeEnvelopeDigest:intakeDigest,
      priorDecisionDigest:priorDigest,candidateId:intake.candidateId,trustDomainId:intake.trustDomainId,
      submitterIdentity:intake.submitterIdentity,submitterTrustDomainId:intake.submitterTrustDomainId,
      submitterIdentityEvidenceRefs:intake.submitterIdentityEvidenceRefs,
      reviewer,admissionStatus:state,verification:makeChecks(state),
      decisionEvidenceRefs:[decisionRef],decisionEvidenceDigests:[{evidenceRef:decisionRef,algorithm:'SHA-256',digest:sha256(decisionEvidenceBytes),mediaType:decisionMedia,observedAt,sourceIdentity:decisionSource}],
      reviewerEvidenceDigests:['id:reviewer','admin:reviewer','recontact:reviewer'].map(ref=>{const e=evidence.get(ref);return {evidenceRef:ref,algorithm:'SHA-256',digest:sha256(e.bytes),mediaType:e.mediaType,observedAt:e.observedAt,sourceIdentity:e.sourceIdentity};}),
      policyVersion:'candidate-intake-v0.1',
      issuedAt:new Date(NOW-30_000).toISOString(),
      reviewerSignature:{algorithm:'Ed25519',keyId:'review-key-001',signedPayloadDigest:'0'.repeat(64),signatureRef:'sig:'+id}
    };
    const sig=signDecision(d), raw=jsonBytes(d), h=sha256(raw);
    decisions.set(h,{bytes:raw});
    signatures.set('sig:'+id,{bytes:sig});
    return {digest:h,decision:d};
  };
  const first=createDecision('EVIDENCE_REVIEW',intakeDigest,'review-1');
  const second=createDecision('IDENTITY_VERIFIED',first.digest,'review-2');
  const third=createDecision('BOUND',second.digest,'review-3');

  const identityResolver={
    async resolve({purpose,evidenceRecords}) {
      if (purpose === 'INDEPENDENT_ADMISSION_REVIEWER') return {
        verified:true,evidenceBindings:[...evidenceRecords].map(([evidenceRef,record])=>({evidenceRef,digest:sha256(record.bytes)})),identityId:options.reviewerIdentityId ?? 'reviewer-001',
        trustDomainId:options.reviewerTrustDomainId ?? 'reviewer-domain',
        adminBoundaryId:options.reviewerAdminBoundaryId ?? 'reviewer-admin',
        keyId:'review-key-001',publicKey
      };
      return {
        verified:true,evidenceBindings:[...evidenceRecords].map(([evidenceRef,record])=>({evidenceRef,digest:sha256(record.bytes)})),identityId:'submitter-001',trustDomainId:'submitter-domain',adminBoundaryId:'submitter-admin'
      };
    }
  };
  const domainVerifiers={};
  for (const domain of keys) domainVerifiers[domain]=async ({evidenceRefs}) => ({
    status:options.domainFailure===domain?'UNVERIFIABLE':'VERIFIED',
    evidenceRefs,
    verifierId:'trusted:'+domain,
    ...(domain==='substrateIdentity'?{trustDomainId:options.substrateTrustDomainId ?? 'candidate-domain',immutableIdentity:'candidate-device-001'}:{}),
    ...(domain==='administrativeSeparation'?{
      candidateAdminBoundaryIds:options.candidateAdminBoundaryIds ?? ['candidate-admin'],
      candidateAdminPrincipalIds:options.candidateAdminPrincipalIds ?? ['candidate-admin-user']
    }:{})
  });
  domainVerifiers.reviewerIndependence=async ({reviewerEvidenceRefs})=>({
    status:options.reviewerIndependenceFailure?'UNVERIFIABLE':'VERIFIED',
    evidenceRefs:reviewerEvidenceRefs,verifierId:'trusted:reviewer-independence'
  });
  const storedReceipts=new Map();
  const deps={
    policy:options.policy ?? policy(),
    runtimeAttestationResolver:{async resolve(){
      const x=policy().verifierRuntime;
      const payload={schema:'ourself.verifier-runtime-attestation.v0.1',runtimeId:x.runtimeId,version:x.version,artifactDigest:x.artifactDigest,
        configDigest:x.configDigest,adminBoundaryId:x.adminBoundaryId,measuredAt:new Date(NOW-1000).toISOString(),components:x.components};
      const raw=Buffer.from(canonicalize(payload));
      return {bytes:raw,signature:sign(null,raw,runtimeKeys.privateKey),signerKeyId:x.attestationKeyId};
    }},
    clock:()=>new Date(NOW),
    intakeStore:{async getById(){return {receiptId:'intake-receipt-001',bytes:intakeBytes};}},
    decisionStore:{async getByDigest(h){return decisions.get(h) ?? null;}},
    evidenceResolver:{async resolve(ref){return options.evidenceOverride?.(ref,evidence.get(ref)) ?? evidence.get(ref) ?? null;}},
    signatureResolver:{async resolve(ref){return options.signatureOverride?.(ref,signatures.get(ref)) ?? signatures.get(ref) ?? null;}},
    identityResolver,
    domainVerifiers,
    revocationChecker:{async check({type,id}){return options.revoked?.(type,id) ? {revoked:true} : {revoked:false};}},
    receiptStore:{
      async appendIfAbsent({digest,bytes}) {
        if (!storedReceipts.has(digest)) storedReceipts.set(digest,Buffer.from(bytes));
        return {receiptId:'admission-receipt:'+digest.slice(0,16),digest};
      },
      async getByDigest(h) {
        if (options.receiptRecontactFailure) return {bytes:Buffer.from('tampered')};
        return storedReceipts.has(h)?{bytes:storedReceipts.get(h)}:null;
      }
    }
  };
  return {verifier:createIndependentAdmissionVerifier(deps),deps,intake,intakeBytes,intakeDigest,decisions,signatures,evidence,storedReceipts,first,second,third,createDecision};
}

test('verifies complete signed review chain and emits content-addressed BOUND receipt', async () => {
  const f=await fixture();
  const out=await f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest});
  assert.equal(out.disposition,'BOUND_VERIFIED');
  assert.equal(sha256(out.bytes),out.digest);
  const receipt=JSON.parse(out.bytes.toString());
  assert.deepEqual(receipt.reviewChain.map(x=>x.state),['EVIDENCE_REVIEW','IDENTITY_VERIFIED','BOUND']);
  assert.equal(receipt.verification.recovery.status,'VERIFIED');
  assert.equal(receipt.verifierRuntime.attestationSignerKeyId,'runtime-attestor-001');
  assert.ok(receipt.verifierRuntime.attestationBytes && receipt.verifierRuntime.attestationSignature);
  assert.equal(receipt.authority.rootKeyGeneration,false);
  assert.equal(f.storedReceipts.size,1);
});

test('rejects a broken predecessor digest before admission', async () => {
  const f=await fixture();
  const bound={...f.third.decision,priorDecisionDigest:'f'.repeat(64)};
  const sig=signDecision(bound), raw=jsonBytes(bound), h=sha256(raw);
  f.decisions.set(h,{bytes:raw}); f.signatures.set('sig:review-3',{bytes:sig});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:h}),e=>e.code==='PREDECESSOR_NOT_FOUND');
  assert.equal(f.storedReceipts.size,0);
});

test('rejects skipped review states', async () => {
  const f=await fixture();
  const bound={...f.third.decision,priorDecisionDigest:f.first.digest};
  const sig=signDecision(bound), raw=jsonBytes(bound), h=sha256(raw);
  f.decisions.set(h,{bytes:raw}); f.signatures.set('sig:review-3',{bytes:sig});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:h}),e=>e.code==='INVALID_TRANSITION');
});

test('rejects altered evidence bytes even when the intake digest is intact', async () => {
  const f=await fixture();
  f.deps.evidenceResolver.resolve=async ref=>{
    if(ref==='ev:custody') return {...f.evidence.get(ref),bytes:Buffer.from('altered')};
    return f.evidence.get(ref);
  };
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='EVIDENCE_DIGEST_MISMATCH');
});

test('rejects stale evidence', async () => {
  const f=await fixture();
  f.deps.policy={...f.deps.policy,maxEvidenceAgeMs:1};
  const verifier=createIndependentAdmissionVerifier(f.deps);
  await assert.rejects(verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='STALE_EVIDENCE');
});

test('rejects unauthenticated evidence source', async () => {
  const f=await fixture();
  f.deps.evidenceResolver.resolve=async ref=>({...f.evidence.get(ref),sourceAuthenticated:false});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='EVIDENCE_SOURCE_UNAUTHENTICATED');
});

test('rejects invalid reviewer signature', async () => {
  const f=await fixture();
  f.deps.signatureResolver.resolve=async ref=>({bytes:Buffer.alloc(64,0)});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_SIGNATURE_INVALID');
});

test('rejects reviewer identity equal to submitter', async () => {
  const f=await fixture({reviewerIdentityId:'submitter-001'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_IS_SUBMITTER');
});

test('rejects reviewer operating in candidate trust domain', async () => {
  const f=await fixture({reviewerTrustDomainId:'candidate-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_DOMAIN_COLLISION');
});

test('rejects reviewer operating in endpoint trust domain', async () => {
  const f=await fixture({reviewerTrustDomainId:'mac-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_IS_ENDPOINT');
});

test('rejects reviewer operating in PORTAL signing trust domain', async () => {
  const f=await fixture({reviewerTrustDomainId:'portal-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_IS_PORTAL_ISSUER');
});

test('rejects reviewer sharing candidate administrator boundary', async () => {
  const f=await fixture({reviewerAdminBoundaryId:'candidate-admin'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_IS_CANDIDATE_ADMIN');
});

test('rejects substrate verifier resolving a different trust domain', async () => {
  const f=await fixture({substrateTrustDomainId:'mac-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='CANDIDATE_SUBSTRATE_BINDING_INVALID');
});

test('rejects revoked reviewer signing key', async () => {
  const f=await fixture({revoked:(type,id)=>type==='SIGNING_KEY'&&id==='review-key-001'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVOCATION_UNRESOLVED');
});

test('rejects a domain verifier that cannot verify recovery evidence', async () => {
  const f=await fixture({domainFailure:'recovery'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='DOMAIN_EVIDENCE_NOT_VERIFIED');
});

test('rejects reviewer recontact that cannot be independently verified', async () => {
  const f=await fixture({reviewerIndependenceFailure:true});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_INDEPENDENCE_UNVERIFIED');
});

test('rejects receipt storage that cannot be independently re-read', async () => {
  const f=await fixture({receiptRecontactFailure:true});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='RECEIPT_RECONTACT_FAILED');
});

test('fails closed when any trusted domain verifier is absent', async () => {
  const f=await fixture();
  delete f.deps.domainVerifiers.custody;
  assert.throws(()=>createIndependentAdmissionVerifier(f.deps),e=>e.code==='VERIFIER_NOT_CONFIGURED');
});

test('receipt remains idempotent on repeated verification', async () => {
  const f=await fixture();
  const a=await f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest});
  const b=await f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest});
  assert.equal(a.digest,b.digest);
  assert.equal(f.storedReceipts.size,1);
});

test('rejects a candidate administrator principal that is the reviewer', async () => {
  const f=await fixture({candidateAdminPrincipalIds:['reviewer-001']});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_IS_CANDIDATE_ADMIN');
});

test('rejects a revoked pinned endpoint trust domain', async () => {
  const f=await fixture({revoked:(type,id)=>type==='TRUST_DOMAIN'&&id==='mac-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVOCATION_UNRESOLVED');
});

test('rejects a revoked candidate trust domain', async () => {
  const f=await fixture({revoked:(type,id)=>type==='TRUST_DOMAIN'&&id==='candidate-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVOCATION_UNRESOLVED');
});

test('rejects unreferenced intake evidence digests', async () => {
  const f=await fixture();
  const intake={...f.intake,evidenceDigests:[...f.intake.evidenceDigests,{evidenceRef:'orphan',algorithm:'SHA-256',digest:'a'.repeat(64),mediaType:'application/octet-stream',observedAt:new Date(NOW-1000).toISOString(),sourceIdentity:'source:orphan'}]};
  f.deps.intakeStore.getById=async()=>({receiptId:'intake-receipt-001',bytes:jsonBytes(intake)});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='EVIDENCE_DIGEST_SCOPE_MISMATCH');
});

test('rejects stale signed review decisions', async () => {
  const f=await fixture();
  f.deps.policy={...f.deps.policy,maxDecisionAgeMs:1};
  const verifier=createIndependentAdmissionVerifier(f.deps);
  await assert.rejects(verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='STALE_EVIDENCE');
});

test('rejects altered reviewer-decision evidence bytes', async () => {
  const f=await fixture();
  f.deps.evidenceResolver.resolve=async ref=>{
    const item=f.evidence.get(ref);
    if(ref.startsWith('ev:decision:')) return {...item,bytes:Buffer.from('altered-review-evidence')};
    return item;
  };
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='DECISION_EVIDENCE_INTEGRITY_FAILED');
});

test('rejects a review decision without its own evidence digest manifest', async () => {
  const f=await fixture();
  const bound={...f.third.decision};
  delete bound.decisionEvidenceDigests;
  const sig=signDecision(bound), raw=jsonBytes(bound), h=sha256(raw);
  f.decisions.set(h,{bytes:raw}); f.signatures.set('sig:review-3',{bytes:sig});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:h}),e=>e.code==='DECISION_FIELD_MISSING');
});

test('rejects an evidence verifier whose runtime identity differs from pinned policy', async () => {
  const f=await fixture();
  f.deps.domainVerifiers.custody=async ({evidenceRefs})=>({status:'VERIFIED',evidenceRefs,verifierId:'unapproved:substitute'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='DOMAIN_EVIDENCE_NOT_VERIFIED');
});

test('rejects duplicate evidence references in the candidate intake', async () => {
  const f=await fixture();
  const intake={...f.intake,administrativeControlEvidence:{submissionState:'SUBMITTED',evidenceRefs:['ev:admin','ev:admin']}};
  f.deps.intakeStore.getById=async()=>({receiptId:'intake-receipt-001',bytes:jsonBytes(intake)});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='EVIDENCE_REFERENCE_DUPLICATE');
});

test('rejects evidence manifests without authenticated source metadata', async () => {
  const f=await fixture();
  const intake={...f.intake,evidenceDigests:f.intake.evidenceDigests.map((x,i)=>i===0?{...x,sourceIdentity:null}:x)};
  f.deps.intakeStore.getById=async()=>({receiptId:'intake-receipt-001',bytes:jsonBytes(intake)});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='EVIDENCE_DIGEST_METADATA_INVALID');
});

test('rejects non-ISO timestamps before freshness evaluation', async () => {
  const f=await fixture();
  const intake={...f.intake,evidenceDigests:f.intake.evidenceDigests.map(x=>x.evidenceRef==='ev:substrate'?{...x,observedAt:'yesterday'}:x)};
  f.deps.intakeStore.getById=async()=>({receiptId:'intake-receipt-001',bytes:jsonBytes(intake)});
  f.deps.evidenceResolver.resolve=async ref=>ref==='ev:substrate'?{...f.evidence.get(ref),observedAt:'yesterday'}:f.evidence.get(ref);
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='INVALID_TIMESTAMP');
});

test('rejects a revoked reviewer trust domain even when identity and key are otherwise valid', async () => {
  const f=await fixture({revoked:(type,id)=>type==='TRUST_DOMAIN'&&id==='reviewer-domain'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVOCATION_UNRESOLVED');
});


test('retrieves and verifies submitter identity evidence bytes against the intake manifest', async () => {
  const f=await fixture();
  f.deps.evidenceResolver.resolve=async ref=>ref==='id:submitter'?{...f.evidence.get(ref),bytes:Buffer.from('substituted-submitter-evidence')}:f.evidence.get(ref);
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='EVIDENCE_DIGEST_MISMATCH');
});

test('rejects reviewer evidence when a reviewer identity reference is absent from its mandatory manifest', async () => {
  const f=await fixture(),changed={...f.third.decision,reviewerEvidenceDigests:f.third.decision.reviewerEvidenceDigests.filter(x=>x.evidenceRef!=='id:reviewer')};
  const sig=signDecision(changed),raw=jsonBytes(changed),h=sha256(raw);f.decisions.set(h,{bytes:raw});f.signatures.set('sig:review-3',{bytes:sig});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:h}),e=>e.code==='REVIEWER_EVIDENCE_SCOPE_MISMATCH');
});

test('retrieves reviewer identity, administrative-separation, and independent-recontact evidence bytes', async () => {
  const f=await fixture(),seen=new Set(),resolve=f.deps.evidenceResolver.resolve;
  f.deps.evidenceResolver.resolve=async ref=>{seen.add(ref);return resolve(ref);};
  await f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest});
  for(const ref of ['id:reviewer','admin:reviewer','recontact:reviewer'])assert.ok(seen.has(ref),ref);
});

test('rejects reviewer identity resolution without evidence digest bindings', async () => {
  const f=await fixture(),resolve=f.deps.identityResolver.resolve;
  f.deps.identityResolver.resolve=async args=>{const result=await resolve(args);return args.purpose==='INDEPENDENT_ADMISSION_REVIEWER'?{...result,evidenceBindings:[]}:result;};
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='IDENTITY_EVIDENCE_BINDING_SCOPE_MISMATCH');
});

test('rejects reviewer identity resolution that binds the wrong evidence digest', async () => {
  const f=await fixture(),resolve=f.deps.identityResolver.resolve;
  f.deps.identityResolver.resolve=async args=>{const result=await resolve(args);return args.purpose==='INDEPENDENT_ADMISSION_REVIEWER'?{...result,evidenceBindings:result.evidenceBindings.map(x=>({...x,digest:'0'.repeat(64)}))}:result;};
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='IDENTITY_EVIDENCE_BINDING_DIGEST_MISMATCH');
});

test('rejects substituted reviewer evidence bytes even when the reviewer adapter claims VERIFIED', async () => {
  const f=await fixture();f.deps.evidenceResolver.resolve=async ref=>ref==='id:reviewer'?{...f.evidence.get(ref),bytes:Buffer.from('substituted-reviewer-identity')}:f.evidence.get(ref);
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='REVIEWER_EVIDENCE_INTEGRITY_FAILED');
});

test('rejects a substituted verifier executable measured by the external attestation authority', async () => {
  const f=await fixture(),x=f.deps.policy.verifierRuntime;
  f.deps.runtimeAttestationResolver.resolve=async()=>{
    const components={...x.components,'domainVerifier:custody':{...x.components['domainVerifier:custody'],artifactDigest:sha256('substituted-executable')}};
    const payload={schema:'ourself.verifier-runtime-attestation.v0.1',runtimeId:x.runtimeId,version:x.version,artifactDigest:x.artifactDigest,
      configDigest:x.configDigest,adminBoundaryId:x.adminBoundaryId,measuredAt:new Date(NOW-1000).toISOString(),components};
    const raw=Buffer.from(canonicalize(payload));return {bytes:raw,signature:sign(null,raw,runtimeKeys.privateKey),signerKeyId:x.attestationKeyId};
  };
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='VERIFIER_COMPONENT_IDENTITY_MISMATCH');
});

test('rejects an unpinned runtime-attestation signing authority',async()=>{
  const f=await fixture();f.deps.runtimeAttestationResolver.resolve=async()=>({bytes:Buffer.from('{}'),signature:Buffer.from('bad'),signerKeyId:'substituted-attestor'});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:f.third.digest}),e=>e.code==='VERIFIER_ATTESTATION_SIGNER_MISMATCH');
});

test('rejects reviewer-decision digest manifests without authenticated provenance metadata', async () => {
  const f=await fixture();
  const changed={...f.third.decision,decisionEvidenceDigests:f.third.decision.decisionEvidenceDigests.map(x=>({...x,sourceIdentity:null}))};
  const sig=signDecision(changed), raw=jsonBytes(changed), h=sha256(raw);
  f.decisions.set(h,{bytes:raw}); f.signatures.set('sig:review-3',{bytes:sig});
  await assert.rejects(f.verifier.verifyBound({intakeReceiptId:'intake-receipt-001',boundDecisionDigest:h}),e=>e.code==='EVIDENCE_DIGEST_METADATA_INVALID');
});
