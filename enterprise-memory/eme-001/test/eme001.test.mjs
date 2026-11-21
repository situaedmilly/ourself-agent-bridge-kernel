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
