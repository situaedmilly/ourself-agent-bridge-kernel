# EME-001 — Enterprise Memory Event Contract v0.1

Status: implementation baseline; not a production authority or legal custody system.

## Constitutional invariants

1. Evidence is not authority.
2. Approval is not admission.
3. Admission is not actuation.
4. Replay is not re-execution.
5. Integrity is not truth.
6. Source authenticity, byte integrity, source identity, content truthfulness, authorization validity, and historical completeness are independent properties.

## Scope

EME-001 defines five separately identified objects:

- **EnterpriseMemoryEvent** — an append-only statement that a state transition or observation was recorded.
- **EvidenceReference** — a controlled reference to supporting source material and its digest.
- **AuthorityAttestation** — a signed, scoped assertion that an identified issuer approved a specific subject/action within a jurisdiction and effective interval. Signature validity alone does not establish the issuer's authority.
- **ExecutionReceipt** — a statement emitted by an execution environment about what it reports doing. It is not an independent witness of effect.
- **IntegrityManifest** — an inventory of package objects, digests, causal references, and custody events.

The JSON Schemas in `schemas/` define the wire envelopes. The Node.js reference module uses only Node built-ins.

## Cryptographic profile EME-CJ-1

- Encoding: UTF-8 JSON.
- Canonicalization: recursive object-key ordering using JavaScript UTF-16 code-unit ordering; arrays retain order; strings and booleans retain value; null is permitted; numbers must be safe integers. Undefined values, non-finite numbers, floats, non-plain objects, and unsafe integers are rejected.
- Digest: SHA-256 over the domain prefix `OURSELF:EME-001:v0.1:<object-type>\0` followed by canonical UTF-8 bytes.
- Signature: Ed25519 over the same domain-separated canonical bytes. Signature records bind a key reference and subject object. Signatures identify a key reference; they do not establish real-world identity or authority without an independently governed trust resolver.
- Import preserves signature records. Cryptographic verification is performed only when an external public-key resolver is supplied; unresolved keys remain explicitly unverified.
- Hashes are lowercase hexadecimal SHA-256 values. Signatures are base64.

This is a deliberately constrained profile, not a claim of RFC 8785/JCS conformance. A future profile migration must be versioned and tested; existing bytes must not be silently recanonicalized.

## Event-chain rules

- Events have a stable event ID, enterprise ID, monotonically increasing sequence, previous-event digest, and content digest.
- The first event has sequence 1 and a null previous-event digest.
- Corrections append a new event with an explicit causal/supersession reference. Existing records are never rewritten.
- The reference file journal is single-writer. It serializes appends within one process and fsyncs each append. Multi-process or distributed writers require an external compare-and-swap/WORM store and are outside this baseline.
- A local append-only API is not tamper-proof storage. File permissions, host custody, backups, replication, and independent verification remain separate controls.

## Replay rules

Replay is a pure projection of recorded `state_operations` into an in-memory JSON state. It supports only `set` and `remove` operations over non-root JSON-pointer paths. It does not import a webhook, billing, network, shell, or actuator interface. Replay never interprets an execution receipt as an instruction.

## Transfer rules

Export/import must preserve original canonical bytes, object digests, signatures, causal references, and custody history. Import verifies integrity and reports unresolved references; it does not create authority, credentials, admissions, or live integrations.

## Explicit non-claims

EME-001 does not establish:
- truthfulness or completeness of source content;
- legal ownership, privilege, consent, or transferability of evidence;
- identity assurance from a key identifier alone;
- authorization from a valid signature alone;
- production-grade WORM retention or distributed consensus;
- successful execution from an approval or admission record;
- independent witnessing from an execution receipt.

## Test command

```sh
node --test enterprise-memory/eme-001/test/eme001.test.mjs
```
