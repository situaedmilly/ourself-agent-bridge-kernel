# Independent Admission Verifier v0.1

Status: IMPLEMENTED LIBRARY · SYNTHETIC TESTS PASSING · PRODUCTION ADAPTERS UNBOUND · NOT DEPLOYED
Date: 2026-11-03
Owning reality: OURSELFECOSYSTEM / OURHARDWARESELFS / INTERCONNECTION / INDEPENDENT-CERTIFIER
Contract inputs:
- INTAKE/CANDIDATE-INTAKE-GATE-v0.1.md
- INTAKE/contracts/candidate-intake.v0.1.schema.json
- INTAKE/contracts/admission-review.v0.1.schema.json

## 1. Purpose and boundary

The verifier evaluates a proposed BOUND admission decision against retrieved bytes, cryptographic signatures, independently resolved identities, evidence-domain verifiers, freshness rules, and revocation status. It emits a content-addressed admission receipt only after the complete review chain passes.

The verifier is a read-mostly library with one bounded output: append a verification receipt to an injected append-only receipt store. It has no root-key, certificate-issuance, trust-bundle-signing, PORTAL-mutation, host-administration, or C10-dispatch interface.

A passing synthetic test proves implementation behavior against test adapters. It does not prove a production adapter, reviewer, candidate trust domain, or physical substrate exists.

## 2. Verification sequence

Input: intakeReceiptId and the content digest of the proposed BOUND decision.

1. Retrieve the intake receipt by ID. Recompute SHA-256 over the exact stored bytes. Parse and structurally validate the intake envelope. Require admissionStatus=RECEIVED.
2. Resolve every candidate evidence reference, including submitter identity evidence, through the authenticated evidence resolver. Recompute SHA-256 over retrieved bytes; compare source identity, media type, and observedAt against the intake digest manifest; enforce freshness and source revocation checks. Submitter identity references are part of the exact intake manifest scope. Reject missing, duplicate, orphaned, stale, unauthenticated, or mismatched evidence.
3. For every review decision, require a decisionEvidenceDigests manifest that exactly matches decisionEvidenceRefs. Every manifest entry must bind a non-empty source identity, media type, timezone-qualified ISO 8601 observation timestamp, and SHA-256 digest. Retrieve every review-evidence byte independently and recompute its SHA-256, source identity, media type, observation time, freshness, and revocation status. Review evidence is separately scoped from candidate-submitted evidence.
4. Retrieve the proposed BOUND decision by digest and recompute the digest over its exact bytes. Retrieve its predecessor by priorDecisionDigest. Require the exact chain:
   - EVIDENCE_REVIEW.priorDecisionDigest = SHA-256(intake envelope bytes)
   - IDENTITY_VERIFIED.priorDecisionDigest = SHA-256(EVIDENCE_REVIEW bytes)
   - BOUND.priorDecisionDigest = SHA-256(IDENTITY_VERIFIED bytes)
5. Bind every decision to the same intake receipt, intake digest, candidate, trust domain, submitter identity, submitter trust domain, submitter evidence, policy version, and reviewer identity/recontact/admin-separation bindings. Reject skipped states and substituted subjects.
6. Resolve reviewer identity and submitter identity independently. Compare resolved identity and trust-domain values against the intake/review claims. Reject a reviewer who is the submitter, belongs to the candidate or submitter trust domain, belongs to either endpoint or PORTAL trust domain, or shares an excluded administrative boundary.
7. Verify Ed25519 signatures for every review decision. The signed payload is deterministic canonical JSON of the complete decision with reviewerSignature omitted. Verify signedPayloadDigest and require the signing key ID to match the key independently resolved for the reviewer. Check reviewer, submitter, candidate, evidence-source, endpoint, PORTAL, substrate, and signing-key revocation state. Unknown revocation state fails closed.
8. Invoke trusted evidence-domain verifiers for substrate identity, administrative separation, jurisdiction, custody, recovery, audit integrity, candidate independent recontact, and reviewer independence/recontact. Each verifier must independently inspect its exact evidence-reference set and return VERIFIED with the exact verifier ID pinned in policy. A verifier callback with an unapproved or missing ID is rejected. Candidate substrate and administrative identities are compared against the reviewer and pinned endpoint/PORTAL boundaries.
9. Confirm that the IDENTITY_VERIFIED and BOUND decisions mark the required checks VERIFIED and reference the exact evidence sets independently checked by the verifier.
10. Construct a deterministic BOUND_VERIFIED receipt, append it with appendIfAbsent, then retrieve it by digest and recompute its digest. A missing, altered, or non-retrievable receipt fails the operation.

## 3. Adapter contracts

All adapters are mandatory. There are no permissive defaults.

| Adapter | Required operation | Trust obligation |
|---|---|---|
| intakeStore | getById(receiptId) | Returns immutable original receipt bytes and exact receipt ID |
| decisionStore | getByDigest(sha256) | Returns immutable original decision bytes by content digest |
| evidenceResolver | resolve(evidenceRef) | Authenticated independent retrieval; returns bytes, source identity, media type, observation time |
| signatureResolver | resolve(signatureRef) | Retrieves raw Ed25519 signature bytes |
| identityResolver | resolve(identityEvidenceRefs, purpose) | Independently establishes identity ID, trust-domain ID, administrative boundary, and reviewer public key/key ID |
| domainVerifiers | seven evidence-domain verifiers plus reviewerIndependence | Trusted, versioned verification code; candidate-controlled callbacks are forbidden |
| revocationChecker | check(type, id) | Returns an affirmative non-revoked result; unknown/error fails closed |
| receiptStore | appendIfAbsent(digest, bytes), getByDigest(digest) | Append-only, immutable, content-addressed storage with independent recontact |

The verifier cannot prove that an adapter is trustworthy merely because it implements the interface. Production deployment must pin adapter code identity, version, configuration digest, trust roots, jurisdiction, and administrative owner. Adapter substitution is a security-sensitive mutation and requires a separate admission/release process.

## 4. Policy bindings

A versioned policy must pin:
- both endpoint trust-domain IDs;
- the PORTAL issuer trust-domain ID(s);
- forbidden endpoint/PORTAL administrative-boundary IDs;
- exact versioned verifier IDs for all seven evidence domains and reviewer independence;
- maximum evidence age;
- maximum decision age;
- maximum permitted clock skew.

These are explicit inputs. The verifier does not infer endpoint identity from hostnames, IP addresses, environment variables, or labels.

## 5. Cryptographic profile

- Hash: SHA-256 over exact retrieved bytes for intake, decisions, and evidence.
- Decision signature: Ed25519.
- Signed decision payload: canonical JSON with lexicographically sorted object keys and reviewerSignature omitted.
- Signing key: independently resolved from reviewer identity evidence; key ID must match.
- Signature bytes: retrieved through signatureResolver and verified with Node.js crypto.verify.

The canonicalization algorithm is versioned with this verifier. Cross-language implementations must reproduce its exact UTF-8 serialization before interoperability is claimed. A future RFC 8785 migration requires an explicit contract version change.

## 6. Admission receipt

The receipt includes:
- intake receipt ID and exact envelope digest;
- candidate and trust-domain identifiers;
- independently verified immutable substrate identity;
- submitter and reviewer identity/trust-domain bindings;
- exact three-decision chain and decision digests;
- separately recomputed digests for each review decision's supporting evidence;
- reviewer signature key IDs and signed-payload digests;
- evidence references and recomputed digests;
- independent verification outcomes and verifier IDs;
- policy version and verification time;
- explicit false values for root-key generation, certificate issuance, trust-bundle signing, PORTAL trust mutation, and C10 dispatch.

The verifier does not sign the receipt. Its integrity is content-addressed and its immutability depends on the injected receipt store's append-only guarantees. The verifier confirms write/read digest equality; it does not independently certify the storage provider's immutability.

## 7. Fail-closed behavior

Any missing adapter, missing predecessor, digest mismatch, invalid signature, identity mismatch, reviewer overlap, stale evidence, unverified domain, revoked or unknown credential, policy mismatch, or failed receipt recontact aborts without producing BOUND_VERIFIED.

Refusal and quarantine decisions are not converted to BOUND. They remain distinct dispositions for a separate review workflow.

## 8. Validation record

Historical baseline validation at the pre-hardening verifier revision:
- Node syntax check: PASS.
- Targeted Node test suites: 45/45 PASS (14 intake-contract assertions and 31 verifier tests).
- Draft 2020-12 schema meta-validation: 2/2 PASS.
- Synthetic Ed25519 keypairs and synthetic adapter fixtures only; no production trust material was used.

Post-hardening verification performed against re-fetched remote blobs:
- Remote source/contract assertions: 10/10 PASS.
- Verifier test cases present: 33 (two new regression cases cover submitter-evidence substitution and reviewer-decision provenance metadata).
- Node test execution after these latest changes: NOT RUN.
- Full Draft 2020-12 meta-validation after these latest code/test changes: NOT RUN; the schema files were not modified in this hardening delta.

The 45/45 baseline result is historical and is not represented as execution of the current 33-case verifier suite.

## 9. Current realization state

- Verifier library: IMPLEMENTED.
- Unit tests: synthetic fixtures only.
- Production evidence resolvers: NOT BOUND.
- Production identity resolver: NOT BOUND.
- Production domain verifiers: NOT BOUND.
- Production revocation source: NOT BOUND.
- Append-only receipt store: NOT BOUND.
- Independent reviewer: NOT ESTABLISHED.
- Candidate trust domain: UNRESOLVED.
- Candidate received: NONE.
- Certifier root: ABSENT.
- Endpoint certificates: NOT ISSUED.
- Trust bundle: NOT SIGNED.
- AetherBridge trust: UNCHANGED / FAIL-CLOSED.
- C10 dispatch: BLOCKED.
- SELFSERVER-2: EXCLUDED.
- Local checkout: NOT TOUCHED.

The next transition after this library is adapter qualification and an independently witnessed integration test. No production binding or trust promotion occurs through this artifact.
