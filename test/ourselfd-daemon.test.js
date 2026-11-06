import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createOURSELFdServer } from "../runtime/ourselfd/daemon.js";

const token = "test-only-agentbridge-secret";

function request(socketPath, method, url, body, authToken = token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath,
      path: url,
      method,
      headers: {
        ...(authToken ? { "x-ourself-agent-token": authToken } : {}),
        ...(payload ? {
          "content-type": "application/json",
          "content-length": String(payload.length)
        } : {})
      }
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode,
        body: raw ? JSON.parse(raw) : null
      }));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ourselfd-daemon-"));
  const stateDir = path.join(root, "state");
  const socketPath = path.join(root, "ourselfd.sock");
  return { root, stateDir, socketPath };
}

test("daemon authenticates AgentBridge, persists transitions, and recontacts after restart", async () => {
  const { root, stateDir, socketPath } = await fixture();
  const repoRoot = process.cwd();
  let daemon = createOURSELFdServer({ repoRoot, socketPath, stateDir, authToken: token });
  await daemon.start();

  const noAuth = await request(socketPath, "GET", "/v1/capabilities", undefined, null);
  assert.equal(noAuth.status, 401);

  const wrongAuth = await request(socketPath, "GET", "/v1/capabilities", undefined, "wrong");
  assert.equal(wrongAuth.status, 401);

  const health = await request(socketPath, "GET", "/health", undefined, null);
  assert.equal(health.status, 200);
  assert.equal(health.body.state, "READY");

  const capabilities = await request(socketPath, "GET", "/v1/capabilities");
  assert.deepEqual(capabilities.body.capabilities.map((item) => item.id), ["repo.status"]);

  const created = await request(socketPath, "POST", "/v1/instances", { purpose: "daemon-recontact" });
  assert.equal(created.status, 201);
  assert.equal(created.body.principal, "agentbridge");
  assert.equal(created.body.pre_state_hash.length, 64);

  const transitioned = await request(socketPath, "POST", "/v1/transitions/request", {
    instance_id: created.body.instance_id,
    pre_state_hash: created.body.pre_state_hash,
    capability: "repo.status",
    operation: "git_status",
    target: "."
  });
  assert.equal(transitioned.status, 200);
  assert.equal(transitioned.body.state, "RECEIPTED");

  const receiptId = transitioned.body.receipt_id;
  await daemon.stop();

  daemon = createOURSELFdServer({ repoRoot, socketPath, stateDir, authToken: token });
  await daemon.start();
  const recontactedReceipt = await request(socketPath, "GET", "/v1/recontact/receipts/" + receiptId);
  const recontactedInstance = await request(socketPath, "GET", "/v1/recontact/instances/" + created.body.instance_id);
  const ledger = await request(socketPath, "GET", "/v1/ledger");

  assert.equal(recontactedReceipt.status, 200);
  assert.equal(recontactedReceipt.body.receipt_id, receiptId);
  assert.equal(recontactedInstance.status, 200);
  assert.equal(recontactedInstance.body.instance_id, created.body.instance_id);
  assert.equal(ledger.body.integrity, "VERIFIED");
  assert.equal(ledger.body.event_count, 2);

  const forbidden = await request(socketPath, "POST", "/v1/transitions/request", {
    instance_id: created.body.instance_id,
    pre_state_hash: created.body.pre_state_hash,
    capability: "shell.execute",
    operation: "anything"
  });
  assert.equal(forbidden.status, 403);

  const notImplemented = await request(socketPath, "POST", "/v1/transitions/request", {
    instance_id: created.body.instance_id,
    pre_state_hash: created.body.pre_state_hash,
    capability: "repo.diff",
    operation: "git_diff"
  });
  assert.equal(notImplemented.status, 403);

  await daemon.stop();
  await fs.rm(root, { recursive: true, force: true });
});

test("daemon refuses startup without a shared secret", async () => {
  const { root, stateDir, socketPath } = await fixture();
  const daemon = createOURSELFdServer({ repoRoot: process.cwd(), socketPath, stateDir, authToken: "" });
  await assert.rejects(daemon.start(), /OURSELFD_AUTH_TOKEN_REQUIRED/);
  await fs.rm(root, { recursive: true, force: true });
});