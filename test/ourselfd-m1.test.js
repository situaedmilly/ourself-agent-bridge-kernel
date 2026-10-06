import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

test("M1 emits a bounded runtime receipt without daemon residence claims", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["runtime/ourselfd/m1.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OURSELF_M1_SOURCE_COMMIT: "test-source-sha"
      },
      maxBuffer: 1024 * 1024
    }
  );

  const receipt = JSON.parse(stdout);
  assert.equal(receipt.receipt_version, "0.1");
  assert.equal(receipt.transition.requested, "repo.status");
  assert.equal(receipt.transition.resolved, "git_status");
  assert.deepEqual(receipt.state_path, [
    "REQUESTED",
    "RESOLVED",
    "AUTHENTICATED",
    "AUTHORIZED",
    "PRECONDITIONS_SATISFIED",
    "ADMITTED",
    "ACTUATED",
    "OBSERVED",
    "RECEIPTED"
  ]);
  assert.equal(receipt.authorization.write_access, false);
  assert.equal(receipt.authorization.shell_access, false);
  assert.equal(receipt.authorization.process_start, false);
  assert.equal(receipt.authorization.launchd, false);
  assert.equal(receipt.authorization.persistent_socket, false);
  assert.equal(receipt.provenance.source_commit, "test-source-sha");
  assert.match(receipt.evidence.digest, /^[a-f0-9]{64}$/);
  assert.equal(receipt.boundary.machine_residence, "NOT_ESTABLISHED");
  assert.equal(receipt.boundary.launchd_authority, "NOT_ESTABLISHED");
});
