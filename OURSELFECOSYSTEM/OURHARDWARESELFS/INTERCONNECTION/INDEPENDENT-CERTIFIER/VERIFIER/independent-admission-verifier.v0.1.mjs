import { createHash, verify as cryptoVerify } from 'node:crypto';

const DOMAINS = ['reviewerIndependence','substrateIdentity','administrativeSeparation','jurisdiction','custody','recovery','auditIntegrity','independentRecontact'];
const EVIDENCE_DOMAINS = DOMAINS.filter(x => x !== 'reviewerIndependence');
const STATES = ['EVIDENCE_REVIEW','IDENTITY_VERIFIED','BOUND'];
const fail = (code, message) => { const e = new Error(message); e.name = 'AdmissionVerificationError'; e.code = code; throw e; };
const need = (ok, code, message) => { if (!ok) fail(code, message); };
export function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
export const sha256 = v => createHash('sha256').update(Buffer.isBuffer(v) ? v : Buffer.from(v)).digest('hex');
const bytes = (v, label) => {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v);
  fail('INVALID_ADAPTER_RESULT', label + ' did not return bytes');
};
const parse = (b, label) => { try { return JSON.parse(bytes(b,label).toString('utf8')); } catch { fail('INVALID_JSON',label + ' is not valid JSON'); } };
const unique = xs => [...new Set(xs)].sort();
const sameSet = (a,b) => JSON.stringify(unique(a ?? [])) === JSON.stringify(unique(b ?? []));
const digest = (v,label) => need(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v),'INVALID_DIGEST',label + ' must be lowercase SHA-256');
const fresh = (value, now, maxAge, skew, label) => {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value),'INVALID_TIMESTAMP',label + ' must be an ISO 8601 date-time with timezone');
  const t = Date.parse(value);
  need(Number.isFinite(t),'INVALID_TIMESTAMP',label + ' timestamp is invalid');
  need(t <= now + skew,'FUTURE_EVIDENCE',label + ' is dated in the future');
  need(now - t <= maxAge,'STALE_EVIDENCE',label + ' exceeds the freshness window');
};
const status = (d,k) => need(d.verification?.[k]?.status === 'VERIFIED','REVIEW_STATUS_NOT_VERIFIED',d.admissionStatus + ' does not mark ' + k + ' VERIFIED');
const validateEvidenceDigest = (d,label) => {
  need(d && typeof d.evidenceRef === 'string' && d.evidenceRef.length,'EVIDENCE_DIGEST_INVALID',label + ' missing evidenceRef');
  digest(d.digest,label + ' digest');
  need(d.algorithm === 'SHA-256','EVIDENCE_DIGEST_ALGORITHM_UNSUPPORTED',label + ' must use SHA-256');
  need(typeof d.sourceIdentity === 'string' && d.sourceIdentity.length && typeof d.mediaType === 'string' && d.mediaType.length && typeof d.observedAt === 'string',
    'EVIDENCE_DIGEST_METADATA_INVALID',label + ' requires sourceIdentity, mediaType, and observedAt');
};
const subjectCheck = (d,i,id,h) => {
  need(d.intakeReceiptId === id,'INTAKE_RECEIPT_MISMATCH','Decision references a different intake receipt');
  need(d.intakeEnvelopeDigest === h,'INTAKE_DIGEST_MISMATCH','Decision does not bind retrieved intake bytes');
  for (const k of ['candidateId','trustDomainId','submitterIdentity','submitterTrustDomainId'])
    need(d[k] === i[k],'SUBJECT_BINDING_MISMATCH','Decision subject mismatch: ' + k);
  need(sameSet(d.submitterIdentityEvidenceRefs,i.submitterIdentityEvidenceRefs),'SUBMITTER_EVIDENCE_MISMATCH','Submitter evidence references changed');
};
const evidenceRefs = i => ({
  submitterIdentity:i.submitterIdentityEvidenceRefs ?? [],
  substrateIdentity:[i.substrateIdentity?.evidenceRef].filter(Boolean),
  administrativeSeparation:i.administrativeControlEvidence?.evidenceRefs ?? [],
  jurisdiction:i.jurisdictionEvidence?.evidenceRefs ?? [],
  custody:i.custodyEvidence?.evidenceRefs ?? [],
  recovery:i.recoveryEvidence?.evidenceRefs ?? [],
  auditIntegrity:i.auditEvidence?.evidenceRefs ?? [],
  independentRecontact:i.independentRecontact?.evidenceRefs ?? []
});
const validateIntake = i => {
  need(i && typeof i === 'object' && !Array.isArray(i),'INVALID_INTAKE','Intake must be an object');
  for (const k of ['candidateId','trustDomainId','submitterIdentity','submitterTrustDomainId','submitterIdentityEvidenceRefs','substrateIdentity','administrativeControlEvidence','jurisdictionEvidence','custodyEvidence','recoveryEvidence','auditEvidence','independentRecontact','evidenceDigests','admissionStatus'])
    need(Object.hasOwn(i,k),'INTAKE_FIELD_MISSING','Intake is missing ' + k);
  need(i.admissionStatus === 'RECEIVED','INTAKE_NOT_RECEIVED','Candidate submission must remain RECEIVED');
  for (const k of ['candidateId','trustDomainId','submitterIdentity','submitterTrustDomainId'])
    need(typeof i[k] === 'string' && i[k].length,'INVALID_INTAKE',k + ' must be non-empty');
  need(Array.isArray(i.submitterIdentityEvidenceRefs) && i.submitterIdentityEvidenceRefs.length,'SUBMITTER_IDENTITY_EVIDENCE_MISSING','Submitter identity evidence is required');
  need(i.substrateIdentity && typeof i.substrateIdentity.evidenceRef === 'string' && i.substrateIdentity.evidenceRef.length && typeof i.substrateIdentity.immutableIdentity === 'string' && i.substrateIdentity.immutableIdentity.length && typeof i.substrateIdentity.identityType === 'string','SUBSTRATE_EVIDENCE_MISSING','Substrate identity must bind immutable identity, type, and evidence reference');
  need(Array.isArray(i.evidenceDigests),'INVALID_INTAKE','evidenceDigests must be an array');
  need(unique(i.submitterIdentityEvidenceRefs).length === i.submitterIdentityEvidenceRefs.length,'SUBMITTER_EVIDENCE_DUPLICATE','Submitter identity evidence references must be unique');
  for (const k of ['administrativeControlEvidence','jurisdictionEvidence','custodyEvidence','recoveryEvidence','auditEvidence','independentRecontact']) {
    const e=i[k];
    need(e && ['MISSING','SUBMITTED'].includes(e.submissionState) && Array.isArray(e.evidenceRefs),'INVALID_EVIDENCE_SECTION',k + ' has invalid submission state');
    if (e.submissionState === 'MISSING') need(e.evidenceRefs.length === 0,'MISSING_EVIDENCE_HAS_REFS',k + ' is MISSING but has references');
    if (e.submissionState === 'SUBMITTED') need(e.evidenceRefs.length > 0,'SUBMITTED_EVIDENCE_EMPTY',k + ' is SUBMITTED without references');
  }
};
const validateDecision = d => {
  need(d && typeof d === 'object' && !Array.isArray(d),'INVALID_DECISION','Review decision must be an object');
  for (const k of ['reviewId','intakeReceiptId','intakeEnvelopeDigest','candidateId','trustDomainId','submitterIdentity','submitterTrustDomainId','submitterIdentityEvidenceRefs','reviewer','admissionStatus','verification','decisionEvidenceRefs','decisionEvidenceDigests','reviewerEvidenceDigests','policyVersion','issuedAt','reviewerSignature'])
    need(Object.hasOwn(d,k),'DECISION_FIELD_MISSING','Decision is missing ' + k);
  digest(d.intakeEnvelopeDigest,'intakeEnvelopeDigest');
  need(STATES.includes(d.admissionStatus),'DECISION_NOT_ADMISSIBLE','Decision state is not an admission progression state');
  for (const k of ['reviewerTrustDomainId','reviewerIdentityEvidenceRefs','administrativeSeparationEvidenceRefs','portalIssuerTrustDomainId','independentRecontactRef'])
    need(Object.hasOwn(d.reviewer ?? {},k),'REVIEWER_FIELD_MISSING','Reviewer is missing ' + k);
  need(typeof d.reviewer.reviewerTrustDomainId === 'string' && d.reviewer.reviewerTrustDomainId.length && typeof d.reviewer.portalIssuerTrustDomainId === 'string' && d.reviewer.portalIssuerTrustDomainId.length && typeof d.reviewer.independentRecontactRef === 'string' && d.reviewer.independentRecontactRef.length,'REVIEWER_FIELD_INVALID','Reviewer identity, PORTAL issuer, and recontact bindings must be non-empty');
  need(Array.isArray(d.reviewer.reviewerIdentityEvidenceRefs) && d.reviewer.reviewerIdentityEvidenceRefs.length && Array.isArray(d.reviewer.administrativeSeparationEvidenceRefs) && d.reviewer.administrativeSeparationEvidenceRefs.length,'REVIEWER_EVIDENCE_MISSING','Reviewer identity and administrative-separation evidence are required');
  for (const k of DOMAINS) need(Object.hasOwn(d.verification ?? {},k),'VERIFICATION_FIELD_MISSING','Missing verification domain ' + k);
  need(Array.isArray(d.decisionEvidenceRefs) && d.decisionEvidenceRefs.length && unique(d.decisionEvidenceRefs).length === d.decisionEvidenceRefs.length && Array.isArray(d.decisionEvidenceDigests), 'DECISION_EVIDENCE_MANIFEST_MISSING', 'Decision evidence references must be unique and have a digest manifest');
  need(Array.isArray(d.reviewerEvidenceDigests),'REVIEWER_EVIDENCE_MANIFEST_MISSING','Reviewer evidence requires a dedicated digest manifest');
  const reviewerRefs=unique([...d.reviewer.reviewerIdentityEvidenceRefs,...d.reviewer.administrativeSeparationEvidenceRefs,d.reviewer.independentRecontactRef]);
  need(reviewerRefs.length===d.reviewer.reviewerIdentityEvidenceRefs.length+d.reviewer.administrativeSeparationEvidenceRefs.length+1,
    'REVIEWER_EVIDENCE_REFERENCE_DUPLICATE','Reviewer evidence references must be unique across identity, administration, and recontact');
  for (const k of ['reviewId','intakeReceiptId','candidateId','trustDomainId','submitterIdentity','submitterTrustDomainId','policyVersion']) need(typeof d[k] === 'string' && d[k].length,'DECISION_FIELD_INVALID','Decision field must be a non-empty string: ' + k);
  need(d.reviewerSignature && d.reviewerSignature.algorithm === 'Ed25519' && typeof d.reviewerSignature.signatureRef === 'string' && d.reviewerSignature.signatureRef.length,'SIGNATURE_MISSING','Ed25519 reviewer signature reference is required');
  need(typeof d.reviewerSignature.keyId === 'string' && d.reviewerSignature.keyId.length,'SIGNING_KEY_ID_MISSING','Reviewer signing key ID is required');
};
const stateRequirements = d => {
  if (['IDENTITY_VERIFIED','BOUND'].includes(d.admissionStatus)) {
    digest(d.priorDecisionDigest,'priorDecisionDigest');
    for (const k of ['substrateIdentity','administrativeSeparation','reviewerIndependence']) status(d,k);
  }
  if (d.admissionStatus === 'BOUND') for (const k of DOMAINS) status(d,k);
};
const payloadBytes = d => {
  const { reviewerSignature, ...payload } = d;
  return Buffer.from(canonicalize(payload));
};
const verifySigned = (d, identity, signature) => {
  const payload = payloadBytes(d);
  need(sha256(payload) === d.reviewerSignature.signedPayloadDigest,'SIGNED_PAYLOAD_DIGEST_MISMATCH','Signed payload digest mismatch: ' + d.reviewId);
  need(d.reviewerSignature.keyId === identity.keyId,'REVIEWER_KEY_MISMATCH','Decision key does not match resolved reviewer key');
  let ok=false; try { ok=cryptoVerify(null,payload,identity.publicKey,signature); } catch {}
  need(ok,'REVIEWER_SIGNATURE_INVALID','Reviewer signature failed: ' + d.reviewId);
};
const identityRecord = (r,label,requireKey=false) => {
  need(r?.verified === true,'IDENTITY_UNVERIFIED',label + ' identity was not independently resolved');
  for (const k of ['identityId','trustDomainId','adminBoundaryId'])
    need(typeof r[k] === 'string' && r[k].length,'IDENTITY_RECORD_INCOMPLETE',label + ' missing ' + k);
  if (requireKey) need(typeof r.keyId === 'string' && r.keyId.length && r.publicKey,'REVIEWER_KEY_BINDING_MISSING','Reviewer signing key is not bound to resolved identity');
};
const clearRevocation = (r,label) => need(r === false || r?.revoked === false,'REVOCATION_UNRESOLVED',label + ' revocation status is not affirmatively clear');
const verifyRuntimeAttestation = async (deps, p, nowMs) => {
  const x=p.verifierRuntime;
  need(x && ['runtimeId','version','artifactDigest','configDigest','adminBoundaryId','attestationKeyId','attestationPublicKey'].every(k=>typeof x[k]==='string'&&x[k].length) &&
    Number.isFinite(x.maxAttestationAgeMs)&&x.maxAttestationAgeMs>0&&x.components&&typeof x.components==='object',
    'VERIFIER_RUNTIME_POLICY_MISSING','Externally pinned runtime identity and attestation authority are required');
  digest(x.artifactDigest,'runtime artifact digest'); digest(x.configDigest,'runtime configuration digest');
  const required=['admissionVerifier','evidenceResolver','identityResolver','signatureResolver','revocationChecker','receiptStore',
    ...[...EVIDENCE_DOMAINS,'reviewerIndependence'].map(k=>'domainVerifier:'+k)];
  for(const id of required){const q=x.components[id];need(q&&typeof q.version==='string'&&q.version.length&&typeof q.adminBoundaryId==='string'&&q.adminBoundaryId.length&&typeof q.artifactDigest==='string'&&typeof q.configDigest==='string','VERIFIER_COMPONENT_POLICY_MISSING','Missing pinned component identity: '+id);digest(q.artifactDigest,id+' artifact digest');digest(q.configDigest,id+' config digest');}
  const e=await deps.runtimeAttestationResolver.resolve();
  need(e&&e.signerKeyId===x.attestationKeyId,'VERIFIER_ATTESTATION_SIGNER_MISMATCH','Runtime attestation signer is not pinned');
  const raw=bytes(e.bytes,'runtimeAttestationResolver'), payload=parse(raw,'runtime attestation');
  need(Buffer.from(canonicalize(payload)).equals(raw),'VERIFIER_ATTESTATION_NONCANONICAL','Runtime attestation must use canonical bytes');
  let ok=false;try{ok=cryptoVerify(null,raw,x.attestationPublicKey,bytes(e.signature,'runtime attestation signature'));}catch{}
  need(ok,'VERIFIER_ATTESTATION_SIGNATURE_INVALID','Runtime attestation signature is invalid');
  need(payload.schema==='ourself.verifier-runtime-attestation.v0.1','VERIFIER_ATTESTATION_SCHEMA_INVALID','Unsupported runtime attestation schema');
  for(const k of ['runtimeId','version','artifactDigest','configDigest','adminBoundaryId'])need(payload[k]===x[k],'VERIFIER_RUNTIME_IDENTITY_MISMATCH','Runtime identity differs from pinned policy: '+k);
  digest(payload.artifactDigest,'measured runtime artifact digest');digest(payload.configDigest,'measured runtime config digest');
  fresh(payload.measuredAt,nowMs,x.maxAttestationAgeMs,p.maxClockSkewMs,'Runtime attestation');
  need(payload.components&&typeof payload.components==='object','VERIFIER_COMPONENTS_MISSING','Measured component set missing');
  for(const id of required)need(payload.components[id]&&canonicalize(payload.components[id])===canonicalize(x.components[id]),'VERIFIER_COMPONENT_IDENTITY_MISMATCH','Measured executable identity/version/configuration/custody differs from pinned policy: '+id);
  need(sameSet(Object.keys(payload.components),required),'VERIFIER_COMPONENT_SCOPE_MISMATCH','Measured component set is incomplete or contains unpinned components');
  return {digest:sha256(raw),runtimeId:payload.runtimeId,version:payload.version,artifactDigest:payload.artifactDigest,configDigest:payload.configDigest,adminBoundaryId:payload.adminBoundaryId,measuredAt:payload.measuredAt};
};

export function createIndependentAdmissionVerifier(deps) {
  for (const k of ['intakeStore','decisionStore','evidenceResolver','signatureResolver','identityResolver','domainVerifiers','revocationChecker','receiptStore','runtimeAttestationResolver'])
    need(deps?.[k],'VERIFIER_NOT_CONFIGURED','Missing adapter: ' + k);
  for (const k of [...EVIDENCE_DOMAINS,'reviewerIndependence']) need(typeof deps.domainVerifiers[k] === 'function','VERIFIER_NOT_CONFIGURED','Missing trusted domain verifier: ' + k);
  const p=deps.policy;
  need(p && typeof p.policyVersion === 'string','POLICY_NOT_CONFIGURED','Versioned policy is required');
  need(Array.isArray(p.endpointTrustDomainIds) && p.endpointTrustDomainIds.length >= 2,'POLICY_NOT_CONFIGURED','Both endpoint trust domains must be pinned');
  need(Array.isArray(p.portalTrustDomainIds) && p.portalTrustDomainIds.length,'POLICY_NOT_CONFIGURED','PORTAL issuer trust domain must be pinned');
  need(Array.isArray(p.forbiddenAdminBoundaryIds) && p.forbiddenAdminBoundaryIds.length,'POLICY_NOT_CONFIGURED','Excluded admin boundaries must be pinned');
  need(p.domainVerifierIds && [...EVIDENCE_DOMAINS,'reviewerIndependence'].every(k=>typeof p.domainVerifierIds[k] === 'string' && p.domainVerifierIds[k].length),'POLICY_NOT_CONFIGURED','Every trusted evidence verifier ID must be pinned in policy');
  need(p.verifierRuntime && typeof p.verifierRuntime === 'object','VERIFIER_RUNTIME_POLICY_MISSING','Externally pinned executable identity policy is required');
  for (const k of ['maxEvidenceAgeMs','maxDecisionAgeMs']) need(Number.isFinite(p[k]) && p[k] > 0,'POLICY_NOT_CONFIGURED','Freshness policy missing: ' + k);
  need(Number.isFinite(p.maxClockSkewMs) && p.maxClockSkewMs >= 0,'POLICY_NOT_CONFIGURED','Clock skew policy missing');

  return Object.freeze({
    async verifyBound({intakeReceiptId,boundDecisionDigest}) {
      need(typeof intakeReceiptId === 'string' && intakeReceiptId.length,'INPUT_INVALID','intakeReceiptId required');
      digest(boundDecisionDigest,'boundDecisionDigest');
      const now=deps.clock ? deps.clock() : new Date();
      const nowMs=now instanceof Date ? now.getTime() : Number(now);
      need(Number.isFinite(nowMs),'CLOCK_INVALID','Verifier clock invalid');

      const runtimeAttestation=await verifyRuntimeAttestation(deps,p,nowMs);
      const ir=await deps.intakeStore.getById(intakeReceiptId);
      need(ir,'INTAKE_NOT_FOUND','Intake receipt not found');
      const intakeBytes=bytes(ir.bytes,'intakeStore.getById');
      const intakeDigest=sha256(intakeBytes);
      need(ir.receiptId === intakeReceiptId,'INTAKE_RECEIPT_ID_MISMATCH','Intake store returned another receipt ID');
      const intake=parse(intakeBytes,'Intake envelope');
      validateIntake(intake);

      const digests=new Map();
      for (const d of intake.evidenceDigests) {
        need(d && typeof d.evidenceRef === 'string' && !digests.has(d.evidenceRef),'EVIDENCE_DIGEST_DUPLICATE','Missing or duplicate evidence digest reference');
        validateEvidenceDigest(d,'Intake evidence ' + d.evidenceRef);
        digests.set(d.evidenceRef,d);
      }
      const refs=evidenceRefs(intake);
      for (const [domain,domainRefs] of Object.entries(refs)) need(unique(domainRefs).length === domainRefs.length,'EVIDENCE_REFERENCE_DUPLICATE','Duplicate evidence reference in ' + domain);
      const allRefs=unique(Object.values(refs).flat());
      need(allRefs.length,'EVIDENCE_MISSING','No candidate evidence was submitted');
      need(sameSet([...digests.keys()],allRefs),'EVIDENCE_DIGEST_SCOPE_MISMATCH','Intake evidence digest set contains missing or unreferenced entries');
      const records=new Map();
      for (const ref of allRefs) {
        const declared=digests.get(ref);
        need(declared,'EVIDENCE_DIGEST_MISSING','No digest record for ' + ref);
        const r=await deps.evidenceResolver.resolve(ref);
        need(r?.independentlyRetrieved === true && r?.sourceAuthenticated === true,'EVIDENCE_SOURCE_UNAUTHENTICATED','Evidence source not independently authenticated: ' + ref);
        const b=bytes(r.bytes,'evidenceResolver');
        need(sha256(b) === declared.digest,'EVIDENCE_DIGEST_MISMATCH','Evidence digest mismatch: ' + ref);
        need(r.sourceIdentity === declared.sourceIdentity && r.mediaType === declared.mediaType && r.observedAt === declared.observedAt,
          'EVIDENCE_PROVENANCE_MISMATCH','Evidence provenance metadata mismatch: ' + ref);
        fresh(r.observedAt,nowMs,p.maxEvidenceAgeMs,p.maxClockSkewMs,'Evidence ' + ref);
        clearRevocation(await deps.revocationChecker.check({type:'EVIDENCE_SOURCE',id:r.sourceIdentity}),'Evidence source');
        records.set(ref,{...r,bytes:b});
      }

      const chain=[]; let current=boundDecisionDigest;
      for (const expected of ['BOUND','IDENTITY_VERIFIED','EVIDENCE_REVIEW']) {
        const rec=await deps.decisionStore.getByDigest(current);
        need(rec,'PREDECESSOR_NOT_FOUND','Decision not found by digest: ' + current);
        const raw=bytes(rec.bytes,'decisionStore');
        need(sha256(raw) === current,'PREDECESSOR_DIGEST_MISMATCH','Retrieved decision bytes do not match requested digest');
        const d=parse(raw,'Review decision');
        validateDecision(d);
        need(d.admissionStatus === expected,'INVALID_TRANSITION','Expected ' + expected + ', found ' + d.admissionStatus);
        subjectCheck(d,intake,intakeReceiptId,intakeDigest);
        need(d.policyVersion === p.policyVersion,'POLICY_VERSION_MISMATCH','Review decision policy version mismatch');
        stateRequirements(d);
        fresh(d.issuedAt,nowMs,p.maxDecisionAgeMs,p.maxClockSkewMs,'Review decision ' + d.reviewId);
        chain.push({decision:d,bytes:raw,digest:current});
        if (expected === 'EVIDENCE_REVIEW') {
          need(d.priorDecisionDigest === intakeDigest,'BROKEN_PREDECESSOR_LINK','EVIDENCE_REVIEW must point to exact intake bytes');
          break;
        }
        current=d.priorDecisionDigest;
      }
      need(chain.length === 3,'INCOMPLETE_REVIEW_CHAIN','Exact EVIDENCE_REVIEW → IDENTITY_VERIFIED → BOUND chain required');
      const ordered=chain.reverse();
      const reviewEvidenceDigests=[];
      const reviewerEvidenceDigests=[];
      for (const item of ordered) {
        const d=item.decision;
        const manifest=new Map();
        for (const entry of d.decisionEvidenceDigests) {
          need(entry && typeof entry.evidenceRef === 'string' && !manifest.has(entry.evidenceRef), 'DECISION_EVIDENCE_DIGEST_DUPLICATE', 'Decision evidence digest is missing or duplicated');
          validateEvidenceDigest(entry,'Decision evidence ' + entry.evidenceRef);
          manifest.set(entry.evidenceRef,entry);
        }
        need(sameSet([...manifest.keys()],d.decisionEvidenceRefs),'DECISION_EVIDENCE_SCOPE_MISMATCH','Decision evidence digest manifest does not exactly match its references');
        for (const ref of d.decisionEvidenceRefs) {
          const declared=manifest.get(ref);
          const r=await deps.evidenceResolver.resolve(ref);
          need(r?.independentlyRetrieved === true && r?.sourceAuthenticated === true,'DECISION_EVIDENCE_SOURCE_UNAUTHENTICATED','Review evidence source is not independently authenticated: ' + ref);
          const raw=bytes(r.bytes,'decision evidence resolver');
          need(sha256(raw) === declared.digest && r.sourceIdentity === declared.sourceIdentity && r.mediaType === declared.mediaType && r.observedAt === declared.observedAt,
            'DECISION_EVIDENCE_INTEGRITY_FAILED','Review evidence digest or provenance mismatch: ' + ref);
          fresh(r.observedAt,nowMs,p.maxEvidenceAgeMs,p.maxClockSkewMs,'Review evidence ' + ref);
          clearRevocation(await deps.revocationChecker.check({type:'EVIDENCE_SOURCE',id:r.sourceIdentity}),'Review evidence source');
          records.set('decision:' + d.reviewId + ':' + ref,{...r,bytes:raw});
          reviewEvidenceDigests.push({scope:'REVIEW_DECISION',reviewId:d.reviewId,evidenceRef:ref,digest:declared.digest});
        }
        const reviewerRefs=unique([...d.reviewer.reviewerIdentityEvidenceRefs,...d.reviewer.administrativeSeparationEvidenceRefs,d.reviewer.independentRecontactRef]);
        const reviewerManifest=new Map();
        for(const entry of d.reviewerEvidenceDigests){need(entry&&typeof entry.evidenceRef==='string'&&!reviewerManifest.has(entry.evidenceRef),'REVIEWER_EVIDENCE_DIGEST_DUPLICATE','Reviewer evidence digest is missing or duplicated');validateEvidenceDigest(entry,'Reviewer evidence '+entry.evidenceRef);reviewerManifest.set(entry.evidenceRef,entry);}
        need(sameSet([...reviewerManifest.keys()],reviewerRefs),'REVIEWER_EVIDENCE_SCOPE_MISMATCH','Reviewer identity, administrative-separation, and recontact references must each have digest-bound evidence');
        for(const ref of reviewerRefs){
          const declared=reviewerManifest.get(ref),r=await deps.evidenceResolver.resolve(ref);
          need(r?.independentlyRetrieved===true&&r?.sourceAuthenticated===true,'REVIEWER_EVIDENCE_SOURCE_UNAUTHENTICATED','Reviewer evidence source is not independently authenticated: '+ref);
          const raw=bytes(r.bytes,'reviewer evidence resolver');
          need(sha256(raw)===declared.digest&&r.sourceIdentity===declared.sourceIdentity&&r.mediaType===declared.mediaType&&r.observedAt===declared.observedAt,'REVIEWER_EVIDENCE_INTEGRITY_FAILED','Reviewer evidence digest or provenance mismatch: '+ref);
          fresh(r.observedAt,nowMs,p.maxEvidenceAgeMs,p.maxClockSkewMs,'Reviewer evidence '+ref);
          clearRevocation(await deps.revocationChecker.check({type:'EVIDENCE_SOURCE',id:r.sourceIdentity}),'Reviewer evidence source');
          records.set(ref,{...r,bytes:raw});
          reviewerEvidenceDigests.push({scope:'REVIEWER_IDENTITY_AND_INDEPENDENCE',reviewId:d.reviewId,evidenceRef:ref,digest:declared.digest});
        }
      }
      const reviewerClaim=ordered[0].decision.reviewer;
      for (const x of ordered) {
        const r=x.decision.reviewer;
        need(r.reviewerTrustDomainId === reviewerClaim.reviewerTrustDomainId &&
          sameSet(r.reviewerIdentityEvidenceRefs,reviewerClaim.reviewerIdentityEvidenceRefs) &&
          sameSet(r.administrativeSeparationEvidenceRefs,reviewerClaim.administrativeSeparationEvidenceRefs) &&
          r.portalIssuerTrustDomainId === reviewerClaim.portalIssuerTrustDomainId &&
          r.independentRecontactRef === reviewerClaim.independentRecontactRef && r.reviewerRole === reviewerClaim.reviewerRole,
          'REVIEWER_CHANGED_IN_CHAIN','Reviewer identity, administrative evidence, role, or recontact changed in the chain');
      }

      const reviewerEvidenceRecords=new Map(unique([...reviewerClaim.reviewerIdentityEvidenceRefs,...reviewerClaim.administrativeSeparationEvidenceRefs,reviewerClaim.independentRecontactRef]).map(ref=>[ref,records.get(ref)]));
      for(const [ref,record] of reviewerEvidenceRecords)need(record?.independentlyRetrieved===true&&record?.sourceAuthenticated===true&&Buffer.isBuffer(record.bytes),'REVIEWER_EVIDENCE_NOT_RETRIEVED','Reviewer evidence bytes were not independently retrieved: '+ref);
      const reviewer=await deps.identityResolver.resolve({identityEvidenceRefs:reviewerClaim.reviewerIdentityEvidenceRefs,administrativeEvidenceRefs:reviewerClaim.administrativeSeparationEvidenceRefs,independentRecontactRef:reviewerClaim.independentRecontactRef,evidenceRecords:reviewerEvidenceRecords,purpose:'INDEPENDENT_ADMISSION_REVIEWER'});
      identityRecord(reviewer,'Reviewer',true);
      need(reviewer.trustDomainId === reviewerClaim.reviewerTrustDomainId,'REVIEWER_DOMAIN_MISMATCH','Resolved reviewer trust domain differs from claim');
      need(reviewer.identityId !== intake.submitterIdentity,'REVIEWER_IS_SUBMITTER','Reviewer is the submitter');
      need(reviewer.trustDomainId !== intake.trustDomainId && reviewer.trustDomainId !== intake.submitterTrustDomainId,
        'REVIEWER_DOMAIN_COLLISION','Reviewer shares candidate or submitter trust domain');
      need(!p.endpointTrustDomainIds.includes(reviewer.trustDomainId),'REVIEWER_IS_ENDPOINT','Reviewer is an endpoint trust domain');
      need(p.portalTrustDomainIds.includes(reviewerClaim.portalIssuerTrustDomainId),'PORTAL_ISSUER_NOT_PINNED','Review PORTAL issuer is not pinned');
      need(reviewer.trustDomainId !== reviewerClaim.portalIssuerTrustDomainId,'REVIEWER_IS_PORTAL_ISSUER','Reviewer shares PORTAL issuer trust domain');
      need(!p.forbiddenAdminBoundaryIds.includes(reviewer.adminBoundaryId),'REVIEWER_ADMIN_BOUNDARY_FORBIDDEN','Reviewer admin boundary is not independent');
      for (const domainId of [...p.endpointTrustDomainIds,...p.portalTrustDomainIds])
        clearRevocation(await deps.revocationChecker.check({type:'TRUST_DOMAIN',id:domainId}),'Pinned endpoint/PORTAL trust domain');
      clearRevocation(await deps.revocationChecker.check({type:'IDENTITY',id:reviewer.identityId}),'Reviewer identity');
      clearRevocation(await deps.revocationChecker.check({type:'TRUST_DOMAIN',id:reviewer.trustDomainId}),'Reviewer trust domain');
      clearRevocation(await deps.revocationChecker.check({type:'SIGNING_KEY',id:reviewer.keyId}),'Reviewer signing key');

      const submitter=await deps.identityResolver.resolve({identityEvidenceRefs:intake.submitterIdentityEvidenceRefs,purpose:'INTAKE_SUBMITTER'});
      identityRecord(submitter,'Submitter');
      need(submitter.identityId === intake.submitterIdentity && submitter.trustDomainId === intake.submitterTrustDomainId,
        'SUBMITTER_IDENTITY_MISMATCH','Resolved submitter identity differs from intake');
      need(submitter.adminBoundaryId !== reviewer.adminBoundaryId,'REVIEWER_SHARES_SUBMITTER_ADMIN','Reviewer and submitter share admin boundary');
      clearRevocation(await deps.revocationChecker.check({type:'IDENTITY',id:submitter.identityId}),'Submitter identity');
      clearRevocation(await deps.revocationChecker.check({type:'TRUST_DOMAIN',id:submitter.trustDomainId}),'Submitter trust domain');
      clearRevocation(await deps.revocationChecker.check({type:'TRUST_DOMAIN',id:intake.trustDomainId}),'Candidate trust domain');

      const sigReceipts=[];
      for (const x of ordered) {
        const sig=await deps.signatureResolver.resolve(x.decision.reviewerSignature.signatureRef);
        need(sig,'SIGNATURE_NOT_FOUND','Signature not found for ' + x.decision.reviewId);
        verifySigned(x.decision,reviewer,bytes(sig.bytes ?? sig,'signatureResolver'));
        sigReceipts.push({reviewId:x.decision.reviewId,keyId:x.decision.reviewerSignature.keyId,signedPayloadDigest:x.decision.reviewerSignature.signedPayloadDigest});
      }

      const context={intake,evidenceRecords:records,reviewerIdentity:reviewer,submitterIdentity:submitter,policy:p,now:new Date(nowMs)};
      const results={};
      for (const domain of EVIDENCE_DOMAINS) {
        const domainRefs=refs[domain];
        need(domainRefs.length,'REQUIRED_EVIDENCE_MISSING','No evidence supplied for ' + domain);
        const result=await deps.domainVerifiers[domain](Object.freeze({...context,evidenceRefs:domainRefs}));
        need(result?.status === 'VERIFIED' && result.verifierId === p.domainVerifierIds[domain] && sameSet(result.evidenceRefs,domainRefs),
          'DOMAIN_EVIDENCE_NOT_VERIFIED','Trusted verifier did not verify exact evidence scope for ' + domain);
        results[domain]=result;
      }
      const substrate=results.substrateIdentity;
      need(substrate.trustDomainId === intake.trustDomainId && typeof substrate.immutableIdentity === 'string' && substrate.immutableIdentity.length,
        'CANDIDATE_SUBSTRATE_BINDING_INVALID','Independent substrate identity does not bind candidate trust domain');
      need(!p.endpointTrustDomainIds.includes(substrate.trustDomainId) && !p.portalTrustDomainIds.includes(substrate.trustDomainId),
        'CANDIDATE_DOMAIN_EXCLUDED','Candidate domain collides with endpoint or PORTAL');
      clearRevocation(await deps.revocationChecker.check({type:'SUBSTRATE_IDENTITY',id:substrate.immutableIdentity}),'Candidate substrate');

      const admin=results.administrativeSeparation;
      need(Array.isArray(admin.candidateAdminBoundaryIds) && admin.candidateAdminBoundaryIds.length &&
        Array.isArray(admin.candidateAdminPrincipalIds) && admin.candidateAdminPrincipalIds.length,
        'CANDIDATE_ADMIN_BOUNDARIES_MISSING','Candidate administrator boundaries and principals were not independently identified');
      need(!admin.candidateAdminBoundaryIds.includes(reviewer.adminBoundaryId) &&
        !admin.candidateAdminBoundaryIds.some(x => p.forbiddenAdminBoundaryIds.includes(x)) &&
        !admin.candidateAdminPrincipalIds?.includes(reviewer.identityId),
        'REVIEWER_IS_CANDIDATE_ADMIN','Reviewer overlaps candidate administrative control');
      for (const principalId of admin.candidateAdminPrincipalIds)
        clearRevocation(await deps.revocationChecker.check({type:'IDENTITY',id:principalId}),'Candidate administrator identity');

      const reviewerEvidence=unique([
        ...reviewerClaim.reviewerIdentityEvidenceRefs,
        ...reviewerClaim.administrativeSeparationEvidenceRefs,
        reviewerClaim.independentRecontactRef,
        ...intake.submitterIdentityEvidenceRefs,
        ...refs.administrativeSeparation
      ]);
      const reviewerCheck=await deps.domainVerifiers.reviewerIndependence(Object.freeze({
        intake,evidenceRecords:records,reviewerIdentity:reviewer,submitterIdentity:submitter,
        reviewerEvidenceRefs:reviewerEvidence,evidenceRecords:reviewerEvidenceRecords,policy:p,now:new Date(nowMs)
      }));
      need(reviewerCheck?.status === 'VERIFIED' && reviewerCheck.verifierId === p.domainVerifierIds.reviewerIndependence && sameSet(reviewerCheck.evidenceRefs,reviewerEvidence),
        'REVIEWER_INDEPENDENCE_UNVERIFIED','Independent reviewer identity, separation, and recontact were not verified as a complete evidence set');
      const actual={};
      for (const domain of EVIDENCE_DOMAINS) actual[domain]={status:'VERIFIED',evidenceRefs:unique(refs[domain]),verifierId:results[domain].verifierId ?? null};
      actual.reviewerIndependence={status:'VERIFIED',evidenceRefs:reviewerEvidence,verifierId:reviewerCheck.verifierId ?? null};
      const identityDecision=ordered[1].decision, bound=ordered[2].decision;
      for (const k of ['substrateIdentity','administrativeSeparation','reviewerIndependence']) {
        status(identityDecision,k);
        const expected=k === 'reviewerIndependence' ? reviewerEvidence : unique(refs[k]);
        need(sameSet(identityDecision.verification[k].evidenceRefs,expected),'REVIEW_EVIDENCE_SCOPE_MISMATCH','IDENTITY_VERIFIED evidence scope mismatch: ' + k);
      }
      for (const k of DOMAINS) {
        status(bound,k);
        const expected=k === 'reviewerIndependence' ? reviewerEvidence : unique(refs[k]);
        need(sameSet(bound.verification[k].evidenceRefs,expected),'REVIEW_EVIDENCE_SCOPE_MISMATCH','BOUND evidence scope mismatch: ' + k);
      }

      const receipt={
        schema:'ourself.independent-admission-verification-receipt.v0.1',
        disposition:'BOUND_VERIFIED',
        intakeReceiptId,
        intakeEnvelopeDigest:intakeDigest,
        candidateId:intake.candidateId,
        trustDomainId:intake.trustDomainId,
        substrateIdentity:substrate.immutableIdentity,
        submitter:{identityId:submitter.identityId,trustDomainId:submitter.trustDomainId},
        reviewer:{identityId:reviewer.identityId,trustDomainId:reviewer.trustDomainId,signingKeyId:reviewer.keyId},
        reviewChain:ordered.map(x=>({reviewId:x.decision.reviewId,state:x.decision.admissionStatus,digest:x.digest})),
        signatures:sigReceipts,
        evidenceDigests:[...allRefs.map(ref=>({scope:'INTAKE',evidenceRef:ref,digest:digests.get(ref).digest})),...reviewEvidenceDigests,...reviewerEvidenceDigests],
        verifierRuntime:runtimeAttestation,
        verification:actual,
        policyVersion:p.policyVersion,
        verifiedAt:new Date(nowMs).toISOString(),
        authority:{rootKeyGeneration:false,certificateIssuance:false,trustBundleSigning:false,portalTrustMutation:false,c10Dispatch:false}
      };
      const receiptBytes=Buffer.from(canonicalize(receipt));
      const receiptDigest=sha256(receiptBytes);
      const stored=await deps.receiptStore.appendIfAbsent({digest:receiptDigest,bytes:receiptBytes});
      need(stored?.digest === receiptDigest && typeof stored.receiptId === 'string',
        'RECEIPT_APPEND_UNCONFIRMED','Append-only receipt store did not confirm exact digest');
      const reread=await deps.receiptStore.getByDigest(receiptDigest);
      need(reread && sha256(bytes(reread.bytes,'receiptStore.getByDigest')) === receiptDigest,
        'RECEIPT_RECONTACT_FAILED','Receipt could not be independently re-read by digest');
      return Object.freeze({receiptId:stored.receiptId,digest:receiptDigest,bytes:Buffer.from(receiptBytes),disposition:'BOUND_VERIFIED',intakeReceiptId,boundDecisionDigest});
    }
  });
}
