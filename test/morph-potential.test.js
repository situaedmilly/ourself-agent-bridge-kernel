import test from "node:test";
import assert from "node:assert/strict";
import { compileMorphField, evaluateMembrane, morphLifecycle } from "../runtime/ourselfd/morph.js";

test("field compiler computes bounded relational potential without granting authority", () => {
  const field = compileMorphField(
    [
      { position: 0, displacement: 10, weight: 1 },
      { position: 10, displacement: 0, weight: 1 }
    ],
    [0, 5, 10],
    { maxDisplacement: 4 }
  );

  assert.equal(field.length, 3);
  assert.ok(field.every((p) => Math.abs(p.displacement) <= 4));
});

test("membrane denies undeclared regions while allowing explicit tolerance", () => {
  const result = evaluateMembrane(
    ["A", "B", "C"],
    ["A"],
    [
      { region: "A", displacement: 2 },
      { region: "B", displacement: 0 },
      { region: "C", displacement: 0 }
    ],
    0
  );

  assert.equal(result[0].admitted, true);
  assert.equal(result[1].admitted, false);
  assert.equal(result[1].withinTolerance, true);
  assert.equal(result[2].admitted, false);
});

test("hostile membrane test rejects unauthorized non-zero field influence", () => {
  const result = evaluateMembrane(
    ["A", "B", "C"],
    ["A"],
    [
      { region: "A", displacement: 1 },
      { region: "B", displacement: 0.01 },
      { region: "C", displacement: 0 }
    ],
    0
  );

  assert.equal(result[1].admitted, false);
  assert.equal(result[1].withinTolerance, false);
});

test("lifecycle contains no declaration-to-verification shortcut", () => {
  const lifecycle = morphLifecycle();
  assert.deepEqual(lifecycle.slice(0, 2), [
    "MORPH_DECLARED",
    "CORRESPONDENCE_VALIDATED"
  ]);
  assert.equal(lifecycle.includes("VERIFIED"), true);
  assert.notDeepEqual(lifecycle.slice(0, 2), ["MORPH_DECLARED", "VERIFIED"]);
});
