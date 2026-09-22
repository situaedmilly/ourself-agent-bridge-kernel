import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createOURSELFdServer } from "../runtime/ourselfd/daemon.js";

function request(socketPath, method, url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: url, method, headers: { "content-type": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

test("daemon exposes only the frozen v0.1 boundary", async (t) => {
  const socketPath = path.join(os.tmpdir(), `ourselfd-test-${process.pid}-${Date.now()}.sock`);
  const daemon = createOURSELFdServer({ repoRoot: process.cwd(), socketPath, requester: "test-agent" });
  await daemon.start();
  t.after(() => daemon.stop());

  const caps = await request(socketPath, "GET", "/v1/capabilities");
  assert.equal(caps.status, 200);
  assert.deepEqual(caps.body.capabilities.map((x) => x.id), [
    "repo.read",
    "repo.status",
    "repo.diff"
  ]);

  const created = await request(socketPath, "POST", "/v1/instances", {
    purpose: "genesis-repo-status"
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.state, "INSTANCE_RESOLVED");

  const receipt = await request(socketPath, "POST", "/v1/transitions/request", {
    instance_id: created.body.instance_id,
    capability: "repo.status",
    operation: "git_status",
    target: "."
  });

  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.state, "RECEIPTED");
  assert.deepEqual(
    receipt.body.states.map((x) => x.state),
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

  const fetched = await request(
    socketPath,
    "GET",
    `/v1/receipts/${receipt.body.receipt_id}`
  );
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.receipt_id, receipt.body.receipt_id);

  const denied = await request(socketPath, "POST", "/v1/transitions/request", {
    instance_id: created.body.instance_id,
    capability: "shell.execute",
    operation: "anything",
    target: "."
  });
  assert.equal(denied.status, 403);
});
