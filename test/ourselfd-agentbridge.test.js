import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { createOURSELFdServer } from "../runtime/ourselfd/daemon.js";
import { createOURSELFdRouter } from "../adapters/ourselfd-router.js";

const token = "test-only-agentbridge-secret";

test("AgentBridge authenticated route binds its credential to OURSELFd principal and authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ourselfd-agentbridge-"));
  const stateDir = path.join(root, "state");
  const socketPath = path.join(root, "ourselfd.sock");
  const daemon = createOURSELFdServer({
    repoRoot: process.cwd(),
    stateDir,
    socketPath,
    authToken: token
  });
  await daemon.start();

  const app = express();
  app.use(express.json());
  app.use("/ourselfd", (req, res, next) => {
    if (req.headers["x-ourself-token"] !== token) {
      return res.status(401).json({ error: "BRIDGE_AUTHENTICATION_REQUIRED" });
    }
    next();
  }, createOURSELFdRouter({ socketPath, token }));

  const bridge = http.createServer(app);
  await new Promise((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  const base = "http://127.0.0.1:" + address.port;

  try {
    const denied = await fetch(base + "/ourselfd/capabilities");
    assert.equal(denied.status, 401);

    const capabilities = await fetch(base + "/ourselfd/capabilities", {
      headers: { "x-ourself-token": token }
    });
    assert.equal(capabilities.status, 200);
    const capabilityBody = await capabilities.json();
    assert.deepEqual(capabilityBody.capabilities.map((item) => item.id), ["repo.status"]);

    const created = await fetch(base + "/ourselfd/instances", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ourself-token": token
      },
      body: JSON.stringify({ purpose: "agentbridge-crossing-test" })
    });
    assert.equal(created.status, 200);
    const instance = await created.json();
    assert.equal(instance.principal, "agentbridge");

    const transitioned = await fetch(base + "/ourselfd/transitions/request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ourself-token": token
      },
      body: JSON.stringify({
        instance_id: instance.instance_id,
        pre_state_hash: instance.pre_state_hash,
        capability: "repo.status",
        operation: "git_status",
        target: "."
      })
    });
    assert.equal(transitioned.status, 200);
    const receipt = await transitioned.json();
    assert.equal(receipt.state, "RECEIPTED");
    assert.equal(receipt.principal, "agentbridge");

    const recontact = await fetch(base + "/ourselfd/receipts/" + encodeURIComponent(receipt.receipt_id), {
      headers: { "x-ourself-token": token }
    });
    assert.equal(recontact.status, 200);
    assert.equal((await recontact.json()).receipt_id, receipt.receipt_id);
  } finally {
    await new Promise((resolve) => bridge.close(resolve));
    await daemon.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});