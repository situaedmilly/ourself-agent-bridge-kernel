import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { OURSELFdCore } from "../runtime/ourselfd/core.js";

const repoRoot = path.resolve(".");

test("repo.status traverses the full non-collapsed transition chain", async () => {
  const daemon = new OURSELFdCore({ repoRoot });
  const instance = daemon.createInstance({ purpose: "genesis-repo-status" });

  assert.equal(instance.state, "INSTANCE_RESOLVED");

  const receipt = await daemon.requestTransition({
    instance_id: instance.instance_id,
    capability: "repo.status",
    operation: "git_status",
    target: "OURSELFEREIGNTY"
  });

  assert.equal(receipt.state, "RECEIPTED");
  assert.deepEqual(
    receipt.states.map(({ state }) => state),
    [
      "REQUESTED",
      "RESOLVED",
      "AUTHENTICATED",
      "AUTHORIZED",
      "PRECONDITIONS_SATISFIED",
      "ADMITTED",
      "ACTUATED",
      "OBSERVED",
      "RECEIPTED"
    ]
  );
  assert.equal(receipt.evidence.observation_hash.length, 64);
  assert.equal(receipt.evidence.request_hash.length, 64);
});

test("forbidden capabilities cannot cross the membrane", async () => {
  const daemon = new OURSELFdCore({ repoRoot });
  const instance = daemon.createInstance();

  await assert.rejects(
    daemon.requestTransition({
      instance_id: instance.instance_id,
      capability: "shell.execute",
      operation: "anything",
      target: "OURSELFEREIGNTY"
    }),
    /CAPABILITY_FORBIDDEN/
  );
});
