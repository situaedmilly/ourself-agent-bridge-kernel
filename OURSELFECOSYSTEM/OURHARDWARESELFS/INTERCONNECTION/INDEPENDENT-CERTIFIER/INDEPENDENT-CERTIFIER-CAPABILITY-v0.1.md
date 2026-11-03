# OURSELF Independent Certifier Capability v0.1

Status: ENGINEERED CONTRACT · HOST BINDING UNRESOLVED · NO ROOT KEY EXISTS OR IS CLAIMED
Date: 2026-11-03
Owning reality: OURSELFECOSYSTEM / OURHARDWARESELFS / INTERCONNECTION

## 1. Purpose and hard boundary

The Independent Certifier is a separately governed trust capability for constrained endpoint certificate issuance and INPUTSELFTRUSTSELF bundle signing. It is not an endpoint, PORTAL decision issuer, host-admin broker, or witness.

No third trust domain has been selected or evidenced. This artifact engineers the capability and custody boundary only. It does not create a hardware identity, root key, certificate, signed trust bundle, or operational certifier.

The root private key MUST NOT reside on either endpoint:
- OURSELFMAC / HW-OURSELFMAC-001
- OURSELFPIMAC / HW-OURSELFPIMAC-001

A new process, VM, directory, key ID, or software label on either endpoint does not create an independent trust domain.

## 2. Non-interchangeable trust roles

| Role | Permitted signing purpose |
|---|---|
| Independent root authority | Endpoint certificate issuance; INPUTSELFTRUSTSELF bundle signature |
| PORTAL decision issuer | Short-lived, operation-specific admission decisions only |
| OURSELFMAC endpoint | TLS proof for the Mac endpoint identity only |
| OURSELFPIMAC endpoint | TLS proof for the Pi endpoint identity only |
| C10 witness | Signed observation evidence only |

The root MUST NOT sign PORTAL operational decisions. PORTAL MUST NOT issue endpoint certificates or sign its own trust bundle. Endpoints MUST NOT certify themselves or each other. The witness MUST NOT certify its own identity or modify trust registries.

## 3. Acceptable deployment profiles

Neither profile is selected yet.

**A. Offline hardware-backed root.** A separately identified physical device holds the root key for controlled signing ceremonies. Key generation occurs on that device, private-key export is disabled, and signing requests move as public reviewable artifacts.

**B. Independently governed signing service.** A third trust domain operates a signing service with hardware-backed non-exportable key custody, auditable operator authentication, immutable signing logs, strict API allowlists, and independently verified administrative control. It is not administered solely through either endpoint's credentials or runtime.

A software-only key file on OURSELFMAC or OURSELFPIMAC is not acceptable. A cloud KMS could qualify only after account ownership, administrators, key hardware properties, policy, audit, recovery, and jurisdiction are evidenced as a distinct trust domain.

## 4. Required trust-domain binding

Before activation, independently verify:
- immutable certifier_id and trust_domain_id;
- physical/service substrate identity and evidence references;
- jurisdiction and administrative-control boundary;
- key algorithm, key ID, public-key fingerprint, and non-exportable/offline custody evidence;
- root custodian and operational signer roles;
- key-generation ceremony record and independent witness;
- certificate profiles, SAN/EKU constraints, and validity limits;
- trust-bundle schema/version and registry digest inputs;
- revocation mechanism and fail-closed behavior;
- backup/recovery custody and compromise response;
- audit-log integrity and independent recontact path.

Unknown values remain null or UNRESOLVED. Never fill a missing binding with an inferred hostname or locator.

## 5. Root key ceremony

No ceremony may run until the third trust domain is selected, identity-verified, and bound.

1. Independently verify substrate identity and custody boundary.
2. Review the root profile and exact permitted signing purposes.
3. Generate the root key inside the selected trust boundary. Do not import a pre-generated private key.
4. Verify non-exportability or documented offline custody controls.
5. Export only public key, key ID, algorithm, and fingerprint.
6. Independently re-read the public key and compare fingerprints.
7. Create a root-custody receipt containing no private material.
8. Record revocation, recovery, and compromise procedures before issuing subordinate material.

No private key, seed, recovery phrase, PIN, or secret enters ChatGPT, Git, issue trackers, logs, or endpoint runtime directories.

## 6. Endpoint certificate issuance

The certifier may sign a public CSR only after the endpoint's hardware identity, jurisdiction, authority, and registry binding are admitted. Each issuance request binds CSR bytes/digest, endpoint identity reference, exact SAN constraints, key usage/EKU, validity interval, evidence references, trust-bundle version, request ID, and one-use nonce.

Endpoint private keys are generated and retained on their respective endpoints. The certifier never receives endpoint private key material. Current labels HW-OURSELFMAC-001 and HW-OURSELFPIMAC-001 are not sufficient evidence by themselves.

## 7. INPUTSELFTRUSTSELF bundle

The signed bundle binds:
- certifier key ID and root fingerprint;
- PORTAL signer public key, key ID, signer identity, and permitted purpose;
- exact source/target endpoint identities and certificate fingerprints;
- validity windows, jurisdiction, and authority grants;
- capability allowlist and operation-profile digest;
- hardware, identity, and jurisdiction registry digests;
- bundle version, issue/expiry times, and revocation reference.

Canonicalization, schema validation, expiry, and revocation checks must be deterministic. Missing bindings, unknown identities, registry-digest mismatch, or an unverifiable root means rejection.

The root signature establishes provenance. It does not grant an operation. PORTAL must still issue a distinct, short-lived, operation-specific admission decision.

## 8. State machine and activation gates

Allowed progression:

DECLARED → DISCOVERED → IDENTITY_VERIFIED → BOUND → KEY_GENERATED → PUBLIC_KEY_VERIFIED → TRUST_ANCHOR_PUBLISHED → ISSUING

No automatic promotion. Invariants:
- capability designed != certifier host selected;
- host selected != identity verified;
- identity verified != root key generated;
- key generated != public key independently verified;
- public key verified != trust anchor admitted;
- trust anchor admitted != endpoint certified;
- endpoint certified != trust bundle valid;
- trust bundle valid != PORTAL admission;
- PORTAL admission != host execution.

Current state: CAPABILITY_ENGINEERED / HOST_BINDING_UNRESOLVED / ROOT_KEY_ABSENT / ISSUANCE_DISABLED.

## 9. Custody and compromise

Root private material remains outside Git and endpoint runtimes. Git may hold public schemas, policy, approved public certificates/fingerprints, and redacted ceremony receipts only. Signing is deny-by-default, allowlisted, immutable, content-addressed, replay-protected, and correlated to an admission record.

Root compromise halts issuance, triggers revocation publication and trust-bundle invalidation, requires endpoint re-enrollment, and requires a separately authorized recovery ceremony. No silent root replacement or automatic rollover. Recovery must preserve role separation.

## 10. Bounded C10 application

Initial use is limited to the pinned ALTONUMBUSELF witness subject:
- repository: situaedmilly/ALTONUMBUSELF
- branch: morph-xi/selfmoat-proving
- commit: 3fdde73c099f9b99814d72dc224c638965be27e9
- path: evidence/morph-xiii/FINAL-PROOF-001.json
- expected SHA-256: 22a4228da535aab04fb653b19f07d71fc81d3305fc9a0db398a2e6acfc717c5f

This does not broaden C10 authority, mutate ALTONUMBUSELF, open the migration gate, or establish REALISELF. SELFSERVER-2 remains excluded.

## 11. Provisioning prerequisites

Before any root-key ceremony:
1. Select a separately controlled third trust domain and identify its exact substrate.
2. Evidence separation from both endpoint identities and administrative credentials.
3. Assign custody, operational, recovery, and compromise roles.
4. Approve the root-key custody mechanism and supported algorithm.
5. Establish independent audit and recontact.

Until all five are admitted, do not generate a production root key, issue certificates, sign a trust bundle, or change AetherBridge trust configuration.
