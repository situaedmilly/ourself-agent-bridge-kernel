# Independent Runtime Authority Qualification 001

- Record ID: `OURSELF-IRAQ-001`
- Assessment date: 2026-11-03
- Assessment scope: currently connected execution estate visible to this session
- Repository: `situaedmilly/ourself-agent-bridge-kernel`
- Qualification branch: `qualification/independent-runtime-authority-v0.1`
- Parent baseline: `4e92ab80719adad5e60ee2e81c4df4c488fd402e`
- Preserved audit baseline: `50c4a81c40d2c9104954a9550e59ee4762ce8e47`
- Disposition: `NO_QUALIFYING_AUTHORITY_EVIDENCED`
- Admission effect: `NONE`

## 1. Purpose

Determine whether the connected execution estate currently exposes an attestation authority that can independently measure the deployed admission verifier and its security-sensitive components, authenticate that measurement with a separately governed signing key, and provide evidence of administrative custody outside the measured OURSELF endpoints and PORTAL signing authority.

This is a qualification assessment, not a root ceremony, key-generation operation, certificate issuance, trust-bundle operation, or admission decision.

## 2. Repository baseline and custody

The feature branch `hardening/reviewer-evidence-boundary-v0.2` was found in the repository. GitHub compare confirmed it is 15 commits ahead of, and 0 behind, the audited baseline `50c4a81c40d2c9104954a9550e59ee4762ce8e47`. The reported latest commit `4e92ab80719adad5e60ee2e81c4df4c488fd402e` was fetched and its validation-record change inspected.

This qualification record is committed on a separate branch created from `4e92ab80719adad5e60ee2e81c4df4c488fd402e`. Neither the audited baseline nor the hardening feature branch is modified by this record. No canonical local repository checkout was used or changed.

## 3. Connected estate examined

The Desktop Commander device inventory returned two online devices:

| Device | Observed platform | Device identifier |
|---|---|---|
| OURSELFMAC.local | macOS, Apple Silicon host | `6aa04271-1f06-4c6b-a774-71d64812dc7c` |
| OURSELFPIMAC | Debian GNU/Linux 13, Linux 6.18.39+rpt-rpi-2712, aarch64 | `467525bc-205d-4c33-91e8-5adddd43bf09` |

These are the complete connected Desktop Commander execution devices returned during this assessment. This does not establish that no other machines, cloud accounts, external services, or independently administered infrastructure exist outside the connected estate.

### 3.1 OURSELFMAC observations

Read-only observations:

- `ioreg -rd1 -c AppleSEPManager` returned an active `AppleSEPManager` instance with `sep-booted = Yes`.
- `system_profiler SPUSBDataType` returned no USB device records in the captured command output.
- `launchctl list` showed Apple platform services including `trustd`, `CryptoTokenKit`, and Secure Backup/FileVault services. No separately identifiable third-party HSM, external attestation authority, or independently administered signing service was evidenced by this listing.
- `security find-identity -v` reported zero valid identities in the current user's login keychain.

Interpretation and limits:

- The Apple Secure Enclave/SEP is a real hardware-backed platform security component observed on OURSELFMAC. It is integrated into the same physical endpoint and operating-system trust boundary being evaluated. No independent administrative custodian, external attestation service, measured-runtime quote, independently pinned authority key, or externally verifiable measurement chain was demonstrated.
- Apple platform trust services are not, by their mere presence, proof of an attestation authority qualified for this protocol.
- The login-keychain result is scoped to that keychain and does not establish the absence of identities in every system store or external service.

### 3.2 OURSELFPIMAC observations

Read-only observations:

- `lsusb` returned only Linux Foundation USB 2.0/3.0 root hubs and host-controller records.
- `/dev/tpm0`, `/dev/tpmrm0`, `/sys/class/tpm/tpm0`, and `/sys/kernel/security/tpm0` were absent.
- `/dev/hwrng` exists as a root-owned character device (mode 0600).
- `/sys/firmware/efi` was absent.
- TPM-named systemd units were listed but inactive; no TPM device node or TPM resource was observed.

Interpretation and limits:

- The hardware random-number device is not a measured-boot or runtime-attestation authority.
- No attached HSM, TPM, or other independently administered signing device was evidenced on the Pi.
- EFI absence is recorded as an observation only; it is not used here to infer a complete secure-boot state.

## 4. Candidate assessment

No candidate met the minimum evidence threshold for qualification.

| Candidate surface | Evidence observed | Qualification result |
|---|---|---|
| OURSELFMAC Apple SEP | Active SEP manager on the measured Mac endpoint | Rejected as an independent trust domain: same endpoint/admin boundary; no external attestation authority or custody evidence established |
| OURSELFPIMAC hardware | USB root hubs only; no TPM device nodes; no HSM identified | Not qualified |
| macOS platform trust services | Apple `trustd` and CryptoTokenKit services | Not qualified: service presence does not establish independent measurement, key custody, or administrative separation |
| GitHub repository/API surface | Repository and branch metadata accessible | Not qualified: source hosting and commit custody do not measure the deployed runtime or independently attest its execution |
| Other cloud/HSM/TEE authority | No connected provider account, endpoint, signed measurement, authority key, or custody evidence was presented in the inspected execution context | Unresolved, not disproven |

Candidate count admitted for further qualification: `0`.

This is a bounded negative finding: no qualifying candidate was evidenced in the connected estate inspected. It is not a universal claim that an external authority does not exist.

## 5. Qualification predicate

A future candidate must provide independently verifiable evidence for every predicate below:

1. **Authority identity:** legal/service identity, stable authority identifier, and independently verifiable signing-key identifier.
2. **Administrative separation:** evidence that authority administration and signing-key control are outside OURSELFMAC, OURSELFPIMAC, the candidate being measured, and PORTAL signing administration.
3. **Key provenance and custody:** documented key origin, generation boundary, hardware protection where claimed, custodian identities, access policy, rotation, revocation, and recovery controls.
4. **Measurement capability:** a documented mechanism that measures the actual deployed verifier executable, runtime, configuration, and security-sensitive adapters. A callback name, self-reported version, source commit, or CI test result is insufficient.
5. **Freshness and anti-replay:** signed nonce/challenge binding, trusted time or monotonic freshness, expiry, and revocation semantics.
6. **Verifier of attestation:** an independently maintained verification path and pinned authority trust anchor, with evidence that the verifier itself is not controlled by the measured runtime.
7. **Recontact:** a separate channel through which the authority's identity, custody, status, and measurement can be rechecked without relying on the candidate or PORTAL.
8. **Audit and recovery:** independently retrievable audit records, incident response, key compromise handling, and recovery/reconstitution procedure.

A candidate must enter the Candidate Intake Gate as `RECEIVED`. This report does not advance any candidate through intake states.

## 6. Non-actions and safety boundary

The assessment performed read-only inventory and repository metadata inspection. It did not:

- generate, import, export, or rotate private keys;
- create a certifier root or endpoint certificate;
- create or sign a trust bundle;
- install or enable services, agents, drivers, packages, or system extensions;
- open ports or establish a new network channel;
- mutate AetherBridge, PORTAL, PIPE, or host-administration runtime state;
- create a candidate admission, reviewer decision, or `BOUND` receipt;
- dispatch C10 or execute host-administration operations;
- modify the local canonical checkout;
- modify the preserved audit baseline or the verifier hardening branch;
- access or mutate SELFSERVER-2.

## 7. Qualification verdict

`NO_QUALIFYING_AUTHORITY_EVIDENCED`

The verifier implementation's external runtime-attestation contract remains an implemented enforcement boundary, but no production authority, independently governed signing key, measured-runtime endpoint, or production trust anchor has been qualified in this assessment.

Consequently:

- Production runtime-attestation authority: `NOT QUALIFIED`
- Production authority public-key trust anchor: `ABSENT / NOT BOUND`
- Independently evidenced administrative custody: `NOT ESTABLISHED`
- Production runtime measurement: `NOT AVAILABLE`
- Production adapters: `NOT BOUND`
- Independent reviewer: `NOT ESTABLISHED`
- Third trust domain: `UNRESOLVED`
- Certifier root: `ABSENT`
- Endpoint certificates: `NOT ISSUED`
- Signed trust bundle: `ABSENT`
- AetherBridge trust: `FAIL-CLOSED`
- C10 dispatch: `BLOCKED`
- Admission: `BLOCKED`

## 8. Next admissible transition

The next transition requires an externally administered authority to be made available for evidence intake. The minimum useful submission is its authority identity and public verification material, signing-key custody/provenance evidence, documented runtime measurement format and challenge flow, administrative-separation evidence, revocation endpoint, and independent recontact path.

Only after those materials are independently retrieved and verified should a candidate be submitted to the Candidate Intake Gate. No local substitute key or OURSELF-hosted signer should be promoted as the third trust domain.

---

**Assessment rule:** `NO CANDIDATE EVIDENCE != PROOF OF NONEXISTENCE`.

**Admission rule:** `IMPLEMENTED ATTESTATION CONTRACT != QUALIFIED AUTHORITY != ADMITTED TRUST DOMAIN`.
