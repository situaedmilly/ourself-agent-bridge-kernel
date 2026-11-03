# Independent Runtime Authority Candidate Discovery 001

- Record ID: `OURSELF-IRAC-001`
- Assessment date: 2026-11-03
- Repository: `situaedmilly/ourself-agent-bridge-kernel`
- Branch: `qualification/intel-trust-authority-candidate-v0.1`
- Parent: `a58b151b3b44c4b03d0efe3cc79a0327b29a2197`
- Preserved audit baseline: `50c4a81c40d2c9104954a9550e59ee4762ce8e47`
- Implementation candidate: `4e92ab80719adad5e60ee2e81c4df4c488fd402e`
- Candidate: Intel® Trust Authority (ITA)
- Disposition: `CANDIDATE_FOR_EVIDENCE_INTAKE / NOT_QUALIFIED`
- Admission effect: `NONE`

## 1. Purpose and scope

Identify an externally administered runtime-attestation authority that can appraise a real TEE quote, bind the appraisal to exact verifier/runtime measurements and a fresh challenge, produce a cryptographically signed result, and expose evidence that the authority's own signing and appraisal services are trustworthy.

This is a public-documentation candidate assessment only. No ITA tenant, API credential, attestation policy, TDX instance, runtime quote, signed token, service contract, or administrative-custody evidence was available or inspected. No candidate has been submitted to the Candidate Intake Gate.

## 2. Primary candidate: Intel Trust Authority

Intel Trust Authority is a remote attestation verifier. Its Appraisal API accepts supported TEE evidence, evaluates measurements and configuration against policies, and returns a signed JWT on successful appraisal. The published token format identifies PS384 as the default signing algorithm and exposes a signing-certificate/JWKS discovery surface.

Primary documentation:
- Attestation overview: https://docs.trustauthority.intel.com/main/articles/articles/ita/concept-attestation-overview.html
- Attestation API: https://docs.trustauthority.intel.com/main/articles/articles/ita/openapi/attestation-v2.html
- Token and claims: https://docs.trustauthority.intel.com/main/articles/articles/ita/concept-attestation-tokens.html
- Faithful Verification: https://docs.trustauthority.intel.com/main/articles/articles/ita/utility-faithful-verifier.html
- Relying-party integration: https://docs.trustauthority.intel.com/main/articles/articles/ita/integrate-relying-party.html
- Signing certificate/JWKS endpoint: https://portal.trustauthority.intel.com/certs
- US API endpoint: https://api.trustauthority.intel.com

### 2.1 Runtime measurement and freshness fit

The documented TDX claims include MRTD and runtime measurement registers (RTMR0-RTMR3), TDX report data, TCB status, and related platform claims. The Appraisal API accepts TDX quote evidence, event logs, runtime data, policy identifiers, and a verifier nonce.

The verifier nonce API returns a signed nonce object containing 64 random bytes and an issue timestamp. The nonce is included in the resulting attestation token. For TDX evidence, runtime data and user data are bound into the quote report-data calculation according to the relevant TDX/API flow.

This gives the proposed protocol a path to bind:
- a verifier-issued fresh challenge;
- the measured TDX boot/runtime registers and event log;
- a canonical manifest of the verifier executable, adapter executables, configuration, and dependency/SBOM digests;
- the resulting appraisal token and policy decision.

Important limit: caller-supplied runtime data is not itself a hardware measurement merely because it appears in a token. The implementation must verify that the TDX quote's report-data binding covers the exact canonical manifest and nonce, and independently map the RTMR/event-log values to the actual boot and workload measurement process. A self-reported digest without this hardware binding is insufficient.

### 2.2 Authority's own runtime and signing evidence

Intel documents that ITA microservices involved in token generation run in TEEs. Each token includes verifier service instance identifiers. The Faithful Verification (FV) mechanism can retrieve an audit report containing the service quotes and related evidence, then independently validate those quotes and compare service measurements against the applicable permit-list policy.

The documented FV evidence is particularly relevant because it can test the authority's own service execution, rather than treating the authority's signed token as self-authenticating. Intel states that the service evidence used by FV is retained for up to two years after token issuance.

FV is a vendor-provided verifier utility. Its executable signature and provenance must themselves be verified, and it must be executed by an independently administered reviewer on a separate verification host. FV success is evidence to evaluate, not an automatic admission decision.

### 2.3 Signing-key and credential distinctions

Do not conflate:
- the ITA token-signing certificate/key, which signs appraisal JWTs and is traceable to Intel's certificate authority; and
- the customer ITA Attestation API key, which authenticates a client making attestation requests.

Intel documentation states that Attestation API keys are distinct from Admin API keys and that the Attestation API key value is retrieved through the portal. That client API key is not proof of the custody or protection of the service's JWT signing key.

Public documentation establishes a useful verification path for the service token and the service's TEE execution. It does not, by itself, establish the tenant-specific administrative separation, complete signing-key custody procedures, key-generation ceremony, access-control evidence, recovery controls, or contractual assurance required by OURSELF. Those remain mandatory evidence requests and independent-review items.

## 3. Candidate substrate: Intel TDX confidential VM

A TDX-capable x86_64 confidential VM is a plausible execution substrate for the admission verifier and its measured security-sensitive adapters. Google Cloud documentation currently identifies Intel TDX as a supported Confidential Space hardware model and describes workload image digest claims, audience, nonce, issuer, and expiry fields.

Google Cloud substrate documentation:
- Confidential Space security overview: https://docs.cloud.google.com/docs/security/confidential-space
- Token claims: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/reference/token-claims
- External relying-party token flow and channel binding: https://docs.cloud.google.com/confidential-computing/confidential-space/docs/connect-external-resources

This does not establish that an OURSELF-controlled Google Cloud account or a suitable project exists. No account was inspected, instance was created, or deployment performed. The exact region/SKU, quote-generation path, event-log format, Intel ITA TDX API compatibility, and runtime measurement coverage must be proven before substrate selection.

The intended separation is:
- workload operator/substrate: a cloud provider and project administered separately from OURSELF endpoint administration;
- attestation verifier: Intel Trust Authority;
- independent recontact/FV reviewer: a separate administrative identity and execution environment;
- relying party: OURSELF admission verifier using pinned Intel trust material and independently validated token/audit evidence.

A cloud project owned and administered solely by the same OURSELF principals would weaken the separation predicate. Provider service independence does not excuse checking customer IAM, organization ownership, billing control, policy administration, and credential custody.

## 4. Alternatives reviewed

| Candidate | Documented capability | Current assessment |
|---|---|---|
| Intel Trust Authority | TDX/SGX appraisal, signed JWT, nonce, runtime-data binding, policy appraisal, Faithful Verification of verifier microservices | Primary candidate for evidence intake; not qualified |
| Microsoft Azure Attestation | TEE/TPM appraisal; nonce and runtime-data inputs; signed JWT; service signing certificate includes evidence of the service's own SEV-SNP TEE | Secondary candidate; service/key measurement and operational evidence still require independent review |
| Google Cloud Attestation / Confidential Space | Confidential VM/Space hardware and workload claims, image digest, audience, nonce, token expiry, OIDC or PKI validation | Strong substrate/service option; does not replace a separately administered verifier if Google is also the workload operator |
| AWS Nitro Enclaves | Nitro Hypervisor-signed CBOR/COSE document with PCRs, timestamp, optional nonce, published AWS Nitro PKI root | Technically viable attester substrate, but a relying party must implement its own external appraisal and policy mechanism; not selected as primary verifier |

Microsoft Azure Attestation documentation:
- https://learn.microsoft.com/en-us/azure/attestation/overview
- https://learn.microsoft.com/en-us/azure/attestation/faq
- https://learn.microsoft.com/en-us/rest/api/attestation/attestation/attest-sev-snp-vm

AWS Nitro documentation:
- https://docs.aws.amazon.com/enclaves/latest/user/verify-root.html
- https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html

## 5. Required evidence before Candidate Intake

The following must be obtained from the actual ITA tenant/service and independently recontacted:

1. **Authority identity:** legal/service identity, region, stable tenant/provider identifiers, official service endpoints, and published trust-anchor provenance.
2. **Token-signing trust:** current certificate/JWKS, certificate chain, signing algorithm, key identifiers, validity, rotation and revocation process, plus evidence supporting the claimed Intel CA relationship.
3. **Signing-key custody:** provider evidence describing signing-key generation/provisioning, TEE/HSM protection, administrative access boundaries, rotation, incident response, and recovery. Do not infer these controls from the existence of a certificate or TEE.
4. **Service execution evidence:** real ITA token with verifier instance IDs and a complete Faithful Verification report; verify each service quote, TEE measurement, permit-list result, and report freshness.
5. **Fresh challenge:** retrieve a live signed nonce, bind it into the TDX quote/runtime-data flow, and verify exact nonce equality, signature, issue time, and replay rejection.
6. **Measured workload:** TDX quote, RTMR values, event log, TCB collateral/status, and exact mapping from those measurements to the verifier image, executable, adapter binaries, configuration, and dependency manifest.
7. **Policy provenance:** tenant policy IDs, immutable policy content/digest, policy signer/administrator identities, matched-policy claims, and evidence that request-supplied policy IDs cannot silently replace the intended pinned policy.
8. **Administrative separation:** independently establish that ITA tenant administration, API-key custody, runtime host administration, and OURSELF/PORTAL administration are distinct. Record named trust-domain and admin-boundary IDs, not just role labels.
9. **Revocation and recontact:** verify current certificate/JWKS and revocation material; independently recontact Intel through a separately sourced support/security channel; establish how tenant suspension, API-key revocation, signing-key rotation, compromised service measurements, and incident notifications are handled.
10. **Independent FV execution:** obtain the FV binary from Intel's official portal, verify its detached signature and certificate, pin its digest/version, and run it from a separate independently administered Linux x86_64 verification environment. Do not disable TLS verification.

All evidence must be retrieved and hashed by the Independent Admission Verifier's authenticated evidence pipeline. Candidate-submitted JSON or a vendor statement alone is not sufficient.

## 6. Candidate intake boundary

If the required initial materials become available, create a candidate record in the existing Candidate Intake Gate with state `RECEIVED`. Preserve the original evidence bytes, source identity, media type, observation timestamp, digest, retrieval provenance, and submitter identity evidence.

Do not advance to `EVIDENCE_REVIEW`, `IDENTITY_VERIFIED`, or `BOUND` until the independent reviewer has verified the required evidence domains and all transition receipts. Do not issue a certifier root, endpoint certificate, trust bundle, or PORTAL mutation as part of discovery or intake.

## 7. Non-actions

This candidate discovery performed public documentation research and repository branch creation only. It did not:
- create an Intel, Google, Microsoft, or AWS account or tenant;
- accept provider terms or incur charges;
- create, retrieve, or store API credentials;
- generate or import any private key;
- provision a TDX VM, enclave, HSM, or other hardware;
- install or run Faithful Verification;
- request a quote or signed attestation token;
- change the connected machines, local checkout, AetherBridge, PORTAL, or host-admin route;
- create an admission receipt, sign a trust bundle, or dispatch C10;
- include SELFSERVER-2.

## 8. Verdict and next admissible transition

`CANDIDATE_FOR_EVIDENCE_INTAKE / NOT_QUALIFIED`

Intel Trust Authority is the strongest documented candidate found in this discovery pass because its documented flow combines external TDX appraisal, signed challenge freshness, policy evaluation, signed attestation tokens, and a Faithful Verification mechanism for the verifier's own TEE services.

This is not yet proof that the actual service instance, tenant configuration, signing-key custody, or external administrative boundaries meet OURSELF's requirements.

Next admissible transition: obtain access to an actual Intel Trust Authority tenant and a separately administered TDX-capable workload substrate, then perform evidence-only preflight and independent recontact. The first successful token must be treated as a test artifact, not admission.

Current system state remains:
- Independent runtime authority: `NOT QUALIFIED`
- Candidate intake state: `NOT RECEIVED`
- Production runtime measurement: `NOT ESTABLISHED`
- Certifier root: `ABSENT`
- Endpoint certificates: `NOT ISSUED`
- Signed trust bundle: `ABSENT`
- AetherBridge trust: `FAIL-CLOSED`
- C10 dispatch: `BLOCKED`
- Admission: `BLOCKED`

---

**Qualification rule:** `PUBLISHED CAPABILITY != TENANT EVIDENCE != INDEPENDENTLY VERIFIED AUTHORITY != ADMITTED TRUST DOMAIN`.
