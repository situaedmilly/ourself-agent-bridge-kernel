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


test("declared-but-unimplemented repository capabilities cannot cross the membrane", async () => {
  const daemon = new OURSELFdCore({ repoRoot });
  const instance = daemon.createInstance();

  assert.deepEqual(
    daemon.capabilities().map(({ id, exposed, implementation_status }) => ({
      id,
      exposed,
      implementation_status
    })),
    [
      {
        id: "repo.read",
        exposed: false,
        implementation_status: "DECLARED_NOT_IMPLEMENTED"
      },
      {
        id: "repo.status",
        exposed: true,
        implementation_status: "IMPLEMENTED"
      },
      {
        id: "repo.diff",
        exposed: false,
        implementation_status: "DECLARED_NOT_IMPLEMENTED"
      }
    ]
  );

  await assert.rejects(
    daemon.requestTransition({
      instance_id: instance.instance_id,
      capability: "repo.read",
      operation: "read_file",
      target: "OURSELFEREIGNTY"
    }),
    /OPERATION_NOT_IMPLEMENTED|CAPABILITY_NOT_FOUND/
  );

  await assert.rejects(
    daemon.requestTransition({
      instance_id: instance.instance_id,
      capability: "repo.diff",
      operation: "git_diff",
      target: "OURSELFEREIGNTY"
    }),
    /OPERATION_NOT_IMPLEMENTED|CAPABILITY_NOT_FOUND/
  );
});
