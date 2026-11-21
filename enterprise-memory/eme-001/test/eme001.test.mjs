import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  AppendOnlyJournal,
  canonicalize,
  createEvent,
  createSignatureRecord,
  exportMemoryPackage,
  importMemoryPackage,
  hashObject,
  replayEvents,
  signObject,
  verifyEventChain,
  verifyEventIntegrity,
  verifyObjectSignature
} from "../src/eme001.mjs";

function event(sequence, previous, overrides = {}) {
  return createEvent({
    event_id: `evt-${sequence}`,
    enterprise_id: "ent-test",
    sequence,
    event_type: "STATE_TRANSITION_RECORDED",
    subject: "vendor.payment_terms",
    recorded_at: `2026-11-21T12:00:0${sequence}Z`,
    source_identity_ref: "identity:source-01",
    state_operations: sequence === 1 ? [{ op: "set", path: "/vendor/payment_terms", value: "NET_60" }] : [],
    evidence_refs: ["evidence:contract-01"],
    previous_event_hash: previous,
    ...overrides
  });
}

test("canonicalization is deterministic and rejects non-integer numbers", () => {
  assert.equal(canonicalize({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.throws(() => canonicalize({ amount: 1.25 }), /safe integers/);
});

test("event integrity detects mutation and chain discontinuity", () => {
  const first = event(1, null);
  const second = event(2, first.content_hash);
  assert.equal(verifyEventIntegrity(first), true);
  assert.deepEqual(verifyEventChain([first, second]).count, 2);
  const tampered = { ...first, subject: "rewritten" };
  assert.equal(verifyEventIntegrity(tampered), false);
  assert.throws(() => verifyEventChain([first, event(2, "0".repeat(64))]), /Previous hash mismatch/);
});

test("Ed25519 signature verifies bytes, not identity or authority", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = { event_hash: "a".repeat(64), action: "approve" };
  const signature = signObject("AuthorityAttestation", payload, privateKey, "key:test-01");
  assert.equal(verifyObjectSignature("AuthorityAttestation", payload, signature, publicKey), true);
  assert.equal(verifyObjectSignature("AuthorityAttestation", { ...payload, action: "transfer" }, signature, publicKey), false);
  assert.equal(signature.key_id, "key:test-01");
  // Deliberately no function here promotes a valid signature into identity or authorization.
});

test("append-only journal persists, reopens, and rejects duplicate or rewritten history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eme001-"));
  const path = join(dir, "events.jsonl");
  try {
    const journal = await AppendOnlyJournal.open(path);
    const first = event(1, null);
    await journal.append(first);
    const second = event(2, first.content_hash);
    await journal.append(second);
    const reopened = await AppendOnlyJournal.open(path);
    assert.equal(reopened.length, 2);
    assert.equal(reopened.head, second.content_hash);
    await assert.rejects(() => reopened.append(first), /Append sequence mismatch|Duplicate event ID/);
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("vendor.payment_terms", "vendor.rewritten"));
    await assert.rejects(() => AppendOnlyJournal.open(path), /Event content hash mismatch/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replay reconstructs state without an execution or actuation path", () => {
  const first = event(1, null);
  const second = event(2, first.content_hash, {
    event_id: "evt-2",
    state_operations: [{ op: "set", path: "/vendor/renewal_owner", value: "team-ops" }]
  });
  const projected = replayEvents([first, second]);
  assert.deepEqual(projected, { vendor: { payment_terms: "NET_60", renewal_owner: "team-ops" } });
  assert.throws(() => replayEvents([first], { constructor: {} }), /Unsafe object key/);
});

test("domain separation prevents cross-object digest substitution", () => {
  const payload = { value: "same bytes" };
  assert.notEqual(hashObject("EvidenceReference", payload), hashObject("AuthorityAttestation", payload));
});

test("export/import verifies exact bytes, manifest inventory, and reports unresolved references without creating authority", () => {
  const first = event(1, null);
  const pkg = exportMemoryPackage([first], {
    package_id: "pkg-01",
    manifest_id: "manifest-01",
    created_at: "2026-11-21T13:00:00Z",
    custody_events: [{
      custodian_identity_ref: "custodian:origin",
      action: "CREATED",
      occurred_at: "2026-11-21T13:00:00Z",
      prior_custody_event_hash: null
    }]
  });
  const imported = importMemoryPackage(pkg);
  assert.equal(imported.integrity_verified, true);
  assert.equal(imported.authority_created, false);
  assert.equal(imported.actuation_enabled, false);
  assert.equal(imported.unresolved_references.length, 1);
  const tampered = structuredClone(pkg);
  tampered.objects[0].canonical_bytes_b64 = Buffer.from(
    tampered.objects[0].canonical_bytes_b64, "base64"
  ).toString("utf8").replace("vendor.payment_terms", "vendor.altered");
  tampered.objects[0].canonical_bytes_b64 = Buffer.from(tampered.objects[0].canonical_bytes_b64).toString("base64");
  assert.throws(() => importMemoryPackage(tampered), /canonical|digest|integrity/i);
});

test("canonicalization lexically orders integer-like object keys", () => {
  assert.equal(canonicalize({ "10": "ten", "2": "two", a: "aye" }), '{"10":"ten","2":"two","a":"aye"}');
});

test("export package builds a verifiable multi-step custody chain", () => {
  const first = event(1, null);
  const pkg = exportMemoryPackage([first], {
    package_id: "pkg-chain",
    manifest_id: "manifest-chain",
    created_at: "2026-11-21T14:00:00Z",
    custody_events: [
      { custodian_identity_ref: "custodian:a", action: "CREATED", occurred_at: "2026-11-21T14:00:00Z" },
      { custodian_identity_ref: "custodian:b", action: "TRANSFERRED", occurred_at: "2026-11-21T14:01:00Z" }
    ]
  });
  assert.equal(importMemoryPackage(pkg).manifest.custody_events.length, 2);
  const broken = structuredClone(pkg);
  broken.manifest.custody_events[1].action = "IMPORTED";
  assert.throws(() => importMemoryPackage(broken), /manifest verification failed/i);
});

test("signature records survive export/import and require an external key resolver for verification", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const first = event(1, null);
  const signedEvent = createEvent({
    ...first,
    source_signature_ref: "sig-02",
    previous_event_hash: null
  });
  const finalSignature = signObject("EnterpriseMemoryEvent", signedEvent, privateKey, "key:source-01");
  const finalSignatureRecord = createSignatureRecord("sig-02", "EnterpriseMemoryEvent", signedEvent.event_id, finalSignature);
  const pkg = exportMemoryPackage([signedEvent, finalSignatureRecord], {
    package_id: "pkg-signature",
    manifest_id: "manifest-signature",
    created_at: "2026-11-21T15:00:00Z"
  });
  const withoutResolver = importMemoryPackage(pkg);
  assert.deepEqual(withoutResolver.unverified_signatures, ["sig-02"]);
  assert.equal(withoutResolver.signature_verification_status, "UNVERIFIED");
  const withResolver = importMemoryPackage(pkg, { publicKeyResolver: () => publicKey });
  assert.deepEqual(withResolver.verified_signatures, ["sig-02"]);
  assert.equal(withResolver.authority_created, false);
  assert.equal(withResolver.signature_verification_status, "VERIFIED");
});
