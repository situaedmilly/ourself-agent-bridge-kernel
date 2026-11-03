# Independent Certifier Candidate Intake Gate v0.1

Status: MANIFESTED CONTRACT · INTAKE ONLY · NO CANDIDATE ADMITTED
Date: 2026-11-03
Owning reality: OURSELFECOSYSTEM / OURHARDWARESELFS / INTERCONNECTION / INDEPENDENT-CERTIFIER
Parent contract: INDEPENDENT-CERTIFIER-CAPABILITY-v0.1

## 1. Purpose

Accept evidence packages for a possible third trust domain without granting that candidate certifier authority. Intake preserves what was submitted, its provenance, and its digests. Independent review determines whether evidence is sufficient, contradictory, missing, or unverifiable.

The intake gate is not a certifier, identity attestor, HSM controller, key ceremony, PORTAL issuer, or provisioning service. It has no signing capability and no host mutation capability.

Core invariant:

CANDIDATE_SUBMITTED != EVIDENCE_VERIFIED != IDENTITY_VERIFIED != BOUND

## 2. Trust-domain exclusions

A candidate must be independent of:
- OURSELFMAC / HW-OURSELFMAC-001;
- OURSELFPIMAC / HW-OURSELFPIMAC-001;
- the PORTAL decision-signing authority and its administrative control plane.

A different process, account label, VM, container, directory, key ID, USB peripheral attached to either endpoint, or second identity on the same administrative plane does not establish a third trust domain.

The reviewer must also operate outside all three excluded domains. The reviewer cannot be the candidate's submitter, candidate administrator, PORTAL decision signer, or either endpoint operator acting through the endpoint control plane.

## 3. Candidate intake envelope

The immutable intake envelope contains these fields:
- candidateId;
- trustDomainId;
- submitterIdentity;
- submitterTrustDomainId;
- submitterIdentityEvidenceRefs;
- substrateIdentity;
- administrativeControlEvidence;
- jurisdictionEvidence;
- custodyEvidence;
- recoveryEvidence;
- auditEvidence;
- independentRecontact;
- evidenceDigests;
- admissionStatus.

All evidence sections, including recoveryEvidence, accept MISSING or SUBMITTED material. The submitter cannot set VERIFIED, IDENTITY_VERIFIED, or BOUND. Every accepted envelope is recorded with admissionStatus=RECEIVED. Missing material is permitted at intake and remains explicitly missing; it is not silently inferred.

Each evidence digest binds a stable evidence reference, SHA-256 digest, media type, observation time, and source identity. Digests establish byte integrity only. They do not establish truth, provenance, independence, or authority.

## 4. State machine

Submission and review are separate immutable records.

Candidate submission:
RECEIVED

Independent review:
RECEIVED → EVIDENCE_REVIEW → IDENTITY_VERIFIED → BOUND

Refusal/containment outcomes:
- REFUSED_MISSING_EVIDENCE
- REFUSED_CONTRADICTORY_EVIDENCE
- REFUSED_UNVERIFIABLE_EVIDENCE
- QUARANTINED

No state is inferred from a previous state, a file's presence, a digest match, a provider product claim, or a candidate's self-attestation. A transition requires a new review decision referencing the prior intake receipt digest. IDENTITY_VERIFIED must reference the preceding EVIDENCE_REVIEW decision; BOUND must reference the preceding IDENTITY_VERIFIED decision. The admission verifier must retrieve and verify that prior decision, enforce the exact adjacent transition, and compare candidateId, trustDomainId, reviewer identity, policy version, and evidence lineage across the chain. Skipped states, mismatched subjects, missing prior decisions, or broken digest links are rejected.

### RECEIVED
The intake envelope has been accepted as bytes and assigned an immutable receipt ID. No evidence is endorsed.

### EVIDENCE_REVIEW
An independent reviewer has been assigned and has begun checking source provenance, identity, administration, jurisdiction, custody, recovery, audit integrity, and recontact. Pending checks remain pending.

### IDENTITY_VERIFIED
The reviewer has independently verified the substrate identity and separate administrative control. This is not yet BOUND and does not authorize root-key generation or signing.

### BOUND
The independent reviewer has verified all required evidence domains: substrate identity, administrative separation, jurisdiction, root-key custody properties, recovery arrangements, audit integrity, and independent recontact. The review decision includes its evidence references and reviewer signature envelope. BOUND is an admission decision, not a key-generation event.

### Refusal and quarantine
Missing, contradictory, or unverifiable evidence produces the matching refusal state. Material conflict, suspected tampering, or unresolved provenance may produce QUARANTINED. Refusal preserves the submitted evidence and reason; it does not repair, overwrite, or discard it. Re-submission creates a new intake receipt linked to the prior receipt.

## 5. Independent reviewer requirements

The reviewer must have a separately evidenced trust-domain identity and administrative control boundary. The reviewer must independently verify:
1. substrate identity against a source controlled by the substrate/provider, not solely a candidate-supplied screenshot or declaration;
2. administrative ownership, privileged administrators, recovery administrators, and credential separation from OURSELFMAC, OURSELFPIMAC, and PORTAL;
3. jurisdiction, contractual control, and applicable legal/administrative boundary;
4. root-key custody, including hardware-backed non-exportability or documented offline custody, key-generation boundary, access ceremony, and dual-control where applicable;
5. backup, recovery, revocation, and compromise arrangements;
6. audit-log origin, integrity, retention, and access controls;
7. independent recontact through a channel not controlled by the candidate or either endpoint.

The reviewer records its own trust-domain ID, identity evidence, separation evidence, independent recontact reference, and signature envelope. Every review decision carries a dedicated reviewerEvidenceDigests manifest covering all three categories. The admission verifier retrieves each byte independently, recomputes its digest, validates provenance/freshness/revocation, and passes the verified records to the identity resolver. The resolver must return exact evidenceBindings (reference + digest); a reviewer assertion or reference alone is not proof.

A reviewer whose identity or trust-domain ID equals the recorded submitter, candidate administrator, either endpoint domain ID, or the PORTAL issuer domain ID must be rejected. The verifier must compare actual identifiers against independently retrieved identity evidence; a self-declared boolean is insufficient.

## 6. BOUND admission predicate

BOUND is permitted only when all are true:
- candidate substrate identity is non-null, immutable, typed, and independently evidenced;
- candidate administrative control and privileged-administrator separation are verified;
- jurisdiction evidence is verified;
- root custody evidence establishes a hardware-backed non-exportable key or approved offline root custody;
- recovery and compromise arrangements are verified;
- audit integrity is verified;
- independent recontact succeeds;
- reviewer identity and reviewer-domain independence are verified;
- reviewer is not the submitter, candidate, candidate administrator, either endpoint, or PORTAL decision authority;
- evidence digests recompute against retrieved bytes;
- no unresolved contradiction, revocation, or quarantine condition remains.

JSON Schema enforces structure and state-dependent required fields. The admission verifier must additionally perform cryptographic signature verification, digest recomputation, evidence retrieval, source authentication, reviewer-domain comparison, revocation checks, and cross-record consistency. It must also verify an externally signed runtime measurement binding the verifier implementation and every security-sensitive adapter/verifier executable to pinned artifact, version, configuration, and administrative-custody identities. A callback-returned verifier ID is not executable identity. A schema-valid record is not proof of evidence truth.

## 7. Immutable records and receipts

The intake envelope is append-only. Review decisions are separate append-only records and include:
- intakeReceiptId and intakeEnvelopeDigest;
- priorDecisionDigest, if any;
- reviewId and candidateId;
- submitter identity and trust-domain identity, bound to the intake receipt;
- submitter identity, submitter trust-domain identity, and submitter identity evidence references bound to the intake receipt;
- reviewer trust-domain identity and evidence references;
- per-domain verification outcomes and evidence references;
- decision state and reason code;
- issuedAt, expiresAt where applicable, and policyVersion;
- reviewer signature algorithm, key ID, signed payload digest, and signature reference.

Do not place private keys, credentials, recovery phrases, access tokens, or secret material in intake records. Redact only through a separately recorded derivative; preserve the original received bytes and digest under the approved evidence-retention policy.

## 8. Authority and no-provisioning boundary

This intake gate MUST NOT:
- generate, import, export, or rotate a root key;
- generate endpoint private keys or CSRs;
- issue endpoint certificates;
- sign or install INPUTSELFTRUSTSELF bundles;
- alter AetherBridge trust configuration;
- issue PORTAL decisions or host-admin admissions;
- install or start Pi services;
- dispatch C10 work;
- mutate ALTONUMBUSELF or its migration gate;
- mutate SELFSERVER-2.

A BOUND decision only admits a candidate trust domain into the certifier's governed trust registry as an eligible authority candidate. It does not execute the later KEY_GENERATED transition. Root ceremony requires a separate, explicit authorization and a separately reviewed ceremony plan.

## 9. Current disposition

No third trust-domain candidate is currently evidenced in the connected estate. No intake candidate is being fabricated to fill the gap.

Gate state: READY_TO_RECEIVE / NO_CANDIDATE_RECEIVED / NO_CANDIDATE_ADMITTED.
Root key: ABSENT.
Endpoint certificates: NOT ISSUED.
Trust bundle: NOT SIGNED.
AetherBridge trust: UNCHANGED / FAIL-CLOSED.
C10 dispatch: NOT AUTHORIZED.
SELFSERVER-2: EXCLUDED.
