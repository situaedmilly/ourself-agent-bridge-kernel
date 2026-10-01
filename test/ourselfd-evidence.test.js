import test from "node:test";
import assert from "node:assert/strict";
import {
  EVIDENCE_SPECIES,
  canonicalize,
  sha256,
  createEvidence,
  createEvidenceGraph,
  assertChainLink
} from "../runtime/ourselfd/evidence.js";

test("canonicalization is recursively key-stable", () => {
  const left = { z: 1, nested: { b: 2, a: 3 } };
  const right = { nested: { a: 3, b: 2 }, z: 1 };
  assert.equal(canonicalize(left), canonicalize(right));
  assert.equal(sha256(left), sha256(right));
});

test("evidence nodes bind payload and parent lineage", () => {
  const first = createEvidence({
    species: "SOURCE",
    instance_id: "instance-test",
    timestamp: "2026-09-22T00:00:00.000Z",
    source: "test",
    payload: { commit: "abc123" }
  });

  const second = createEvidence({
    species: "BUILD",
    instance_id: "instance-test",
    parent_evidence_id: first.evidence_id,
    parent_event_hash: first.event_hash,
    timestamp: "2026-09-22T00:01:00.000Z",
    source: "test",
    state: "BUILD_STARTED",
    payload: { command: "npm test" }
  });

  assert.equal(first.species, "SOURCE");
  assert.equal(second.parent_evidence_id, first.evidence_id);
  assert.equal(second.parent_event_hash, first.event_hash);
  assert.match(first.payload_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.event_hash, /^[a-f0-9]{64}$/);
  assert.equal(assertChainLink(first, second), true);
});

test("graph appends the canonical M1 lifecycle species in order", () => {
  const graph = createEvidenceGraph({
    instance_id: "instance-m1-test",
    source: "ourselfd-m1-test",
    timestampFactory: (() => {
      let n = 0;
      return () => `2026-09-22T00:00:0${n++}.000Z`;
    })()
  });

  for (const species of EVIDENCE_SPECIES) {
    graph.append({ species, payload: { species } });
  }

  assert.deepEqual(
    graph.nodes().map(({ species }) => species),
    [...EVIDENCE_SPECIES]
  );

  const nodes = graph.nodes();
  for (let i = 1; i < nodes.length; i += 1) {
    assert.equal(nodes[i].parent_evidence_id, nodes[i - 1].evidence_id);
    assert.equal(nodes[i].parent_event_hash, nodes[i - 1].event_hash);
  }
});

test("invalid species cannot enter the evidence graph", () => {
  assert.throws(
    () => createEvidence({
      species: "HALLUCINATION",
      instance_id: "instance-test",
      timestamp: "2026-09-22T00:00:00.000Z",
      source: "test",
      payload: {}
    }),
    /EVIDENCE_SPECIES_INVALID/
  );
});

test("broken lineage cannot be admitted", () => {
  const first = createEvidence({
    species: "SOURCE",
    instance_id: "instance-test",
    timestamp: "2026-09-22T00:00:00.000Z",
    source: "test",
    payload: {}
  });
  const second = createEvidence({
    species: "BUILD",
    instance_id: "instance-test",
    parent_evidence_id: "wrong-parent",
    parent_event_hash: first.event_hash,
    timestamp: "2026-09-22T00:01:00.000Z",
    source: "test",
    payload: {}
  });

  assert.throws(() => assertChainLink(first, second), /PARENT_EVIDENCE_MISMATCH/);
});
