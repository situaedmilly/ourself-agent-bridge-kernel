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
3. For every review decision, require a decisionEvidenceDigests manifest that exactly matches decisionEvidenceRefs, plus a reviewerEvidenceDigests manifest that exactly matches reviewerIdentityEvidenceRefs, administrativeSeparationEvidenceRefs, and independentRecontactRef. Retrieve each reviewer evidence object through the authenticated resolver. Recompute SHA-256, validate source identity/media type/observation time, enforce freshness and revocation checks, and reject any reference without a retrieved record. The reviewer manifest is mandatory on every decision in the three-stage chain.
4. Retrieve the proposed BOUND decision by digest and recompute the digest over its exact bytes. Retrieve its predecessor by priorDecisionDigest. Require the exact chain:
   - EVIDENCE_REVIEW.priorDecisionDigest = SHA-256(intake envelope bytes)
   - IDENTITY_VERIFIED.priorDecisionDigest = SHA-256(EVIDENCE_REVIEW bytes)
   - BOUND.priorDecisionDigest = SHA-256(IDENTITY_VERIFIED bytes)
5. Bind every decision to the same intake receipt, intake digest, candidate, trust domain, submitter identity, submitter trust domain, submitter evidence, policy version, and reviewer identity/recontact/admin-separation bindings. Reject skipped states and substituted subjects.
6. Resolve reviewer identity and submitter identity independently using the exact retrieved evidence-record maps. Require each resolver result to return evidenceBindings that enumerate every supplied evidence reference and the exact SHA-256 digest of its retrieved bytes. Compare resolved identity and trust-domain values against the intake/review claims. Reject a reviewer who is the submitter, belongs to the candidate or submitter trust domain, belongs to either endpoint or PORTAL trust domain, or shares an excluded administrative boundary.
7. Verify Ed25519 signatures for every review decision. The signed payload is deterministic canonical JSON of the complete decision with reviewerSignature omitted. Verify signedPayloadDigest and require the signing key ID to match the key independently resolved for the reviewer. Check reviewer, submitter, candidate, evidence-source, endpoint, PORTAL, substrate, and signing-key revocation state. Unknown revocation state fails closed.
8. Before evidence evaluation, verify a fresh Ed25519 runtime attestation signed by an externally pinned attestation authority. The attestation must bind the verifier runtime artifact/version/configuration/administrative boundary and exact measured component identities for the admission verifier, identity resolver, evidence resolver, signature resolver, revocation checker, receipt store, and every domain verifier. Callback-returned verifier IDs remain descriptive only; they are not executable identity. Invoke the measured evidence-domain verifiers for substrate identity, administrative separation, jurisdiction, custody, recovery, audit integrity, candidate independent recontact, and reviewer independence/recontact. Candidate substrate and administrative identities are compared against the reviewer and pinned endpoint/PORTAL boundaries.
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
| identityResolver | resolve(identityEvidenceRefs, evidenceRecords, purpose) | Independently establishes identity ID, trust-domain ID, administrative boundary, reviewer public key/key ID, and returns exact evidenceBindings (reference + SHA-256) |
| domainVerifiers | seven evidence-domain verifiers plus reviewerIndependence | Trusted, versioned verification code whose measured executable identity is pinned by the external runtime attestation |
| revocationChecker | check(type, id) | Returns an affirmative non-revoked result; unknown/error fails closed |
| receiptStore | appendIfAbsent(digest, bytes), getByDigest(digest) | Append-only, immutable, content-addressed storage with independent recontact |
| runtimeAttestationResolver | resolve() | Retrieves canonical signed runtime measurement from an independent attestation authority |

The verifier cannot prove that an adapter is trustworthy merely because it implements the interface. Production deployment must pin adapter code identity, version, configuration digest, trust roots, jurisdiction, and administrative owner. Adapter substitution is a security-sensitive mutation and requires a separate admission/release process.

## 4. Policy bindings

A versioned policy must pin:
- both endpoint trust-domain IDs;
- the PORTAL issuer trust-domain ID(s);
- forbidden endpoint/PORTAL administrative-boundary IDs;
- exact versioned verifier IDs for all seven evidence domains and reviewer independence;
- external runtime-attestation trust-anchor key ID and public key;
- verifier runtime artifact/version/configuration digest and administrative boundary;
- artifact/version/configuration digest and administrative boundary for every security-sensitive resolver and verifier component;
- maximum runtime-attestation age;
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

The verifier receipt includes the complete signed external runtime-attestation envelope (canonical payload bytes, signer key ID, and signature), its digest, and the reviewer evidence manifest digests. This permits a downstream independent verifier to re-check the measurement rather than trusting a returned runtime ID. The verifier does not sign the receipt. Its integrity is content-addressed and its immutability depends on the injected receipt store's append-only guarantees. The verifier confirms write/read digest equality; it does not independently certify the storage provider's immutability.

## 7. Fail-closed behavior

Any missing adapter, missing predecessor, digest mismatch, invalid signature, identity mismatch, reviewer overlap, stale evidence, unverified domain, revoked or unknown credential, policy mismatch, or failed receipt recontact aborts without producing BOUND_VERIFIED.

Refusal and quarantine decisions are not converted to BOUND. They remain distinct dispositions for a separate review workflow.

## 8. Validation record

Current hardening branch validation was performed against freshly fetched remote blobs in an isolated temporary directory on OURSELFMAC:

- Working directory: `/tmp/ourself-verifier-v02-isolated`.
- Canonical repository checkout: NOT TOUCHED.
- Node syntax check for the verifier module: PASS.
- Independent Admission Verifier suite: 42/42 PASS.
- Candidate Intake Gate contract suite: 15/15 PASS.
- Combined Node test execution: 57/57 PASS, 0 failures, 0 skipped.
- Draft 2020-12 JSON Schema meta-validation: 2/2 PASS.
- Tests use synthetic Ed25519 reviewer and runtime-attestation keys. They validate fail-closed behavior and contract enforcement, not production trust material or a real hardware/TEE measurement authority.

The earlier 45/45 result belongs to the pre-hardening baseline and is retained only as historical context. It is not the validation count for this branch.

## 9. Current realization state

Current hardening branch: `hardening/reviewer-evidence-boundary-v0.2`.

The branch now enforces:
- Mandatory reviewer identity, administrative-separation, and independent-recontact digest manifests on every review decision in the exact three-stage chain.
- Independent retrieval of each reviewer evidence object, SHA-256 recomputation, provenance validation, freshness checks, and evidence-source revocation checks.
- Identity resolver input bound to the exact retrieved evidence-record maps; resolver output must enumerate exact evidence references and matching SHA-256 digests.
- A frozen policy snapshot.
- Fresh Ed25519 runtime attestation from an externally pinned authority, binding runtime artifact/version/configuration/administrative custody and the measured identities of the verifier and security-sensitive adapters.
- Rejection when verifier runtime or component administrative boundaries overlap forbidden endpoint/PORTAL boundaries, reviewer administration, or candidate administration.
- Inclusion of the signed runtime-attestation envelope in the content-addressed verification receipt.

The runtime-attestation authority, its public-key trust anchor, measured production component identities, and production administrative-custody evidence remain deployment trust inputs. Synthetic test keys are not production trust anchors. The library cannot manufacture or independently establish the existence of an external hardware/TEE measurement authority.

- Verifier library: IMPLEMENTED / HARDENED IN FEATURE BRANCH.
- Unit tests: 57/57 PASS using synthetic fixtures.
- Production evidence resolver: NOT BOUND.
- Production identity resolver: NOT BOUND.
- Production domain verifiers: NOT BOUND.
- Production revocation source: NOT BOUND.
- Production runtime-attestation authority: NOT BOUND.
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

The next transition is not admission or provisioning. It is independent qualification of the runtime-attestation authority and production adapters, followed by an independently witnessed integration test. No trust promotion occurs through this artifact.
