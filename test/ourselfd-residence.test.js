import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateMachineResidence,
  requiredResidenceEvidence
} from "../runtime/ourselfd/residence.js";

const instance_id = "instance-test-residence";
const process_identity = "pid:12345";

function evidence(species, payload = {}) {
  return { species, instance_id, payload };
}

test("machine residence remains unproven until every residence evidence species exists", () => {
  const result = evaluateMachineResidence([
    evidence("INSTALL"),
    evidence("LOAD"),
    evidence("BIRTH", { process_identity }),
    evidence("PROCESS_IDENTITY", { process_identity }),
    evidence("LIVENESS", { process_identity })
  ]);

  assert.equal(result.state, "UNPROVEN");
  assert.deepEqual(result.missing, ["RECONTACT"]);
});

test("machine residence is proven only after recontact confirms the born process identity", () => {
  const graph = requiredResidenceEvidence().map((species) =>
    evidence(species, { process_identity })
  );

  const result = evaluateMachineResidence(graph);

  assert.equal(result.state, "PROVEN");
  assert.equal(result.instance_id, instance_id);
  assert.equal(result.process_identity, process_identity);
});

test("machine residence proof rejects cross-instance evidence", () => {
  const graph = requiredResidenceEvidence().map((species) =>
    evidence(species, { process_identity })
  );
  graph[5] = {
    ...graph[5],
    instance_id: "foreign-instance"
  };

  const result = evaluateMachineResidence(graph);

  assert.equal(result.state, "UNPROVEN");
  assert.equal(result.reason, "INSTANCE_LINEAGE_MISMATCH");
});

test("machine residence proof rejects recontact of a different process", () => {
  const graph = requiredResidenceEvidence().map((species) =>
    evidence(species, {
      process_identity: species === "RECONTACT" ? "pid:99999" : process_identity
    })
  );

  const result = evaluateMachineResidence(graph);

  assert.equal(result.state, "UNPROVEN");
  assert.equal(result.reason, "PROCESS_IDENTITY_RECONTACT_MISMATCH");
});
