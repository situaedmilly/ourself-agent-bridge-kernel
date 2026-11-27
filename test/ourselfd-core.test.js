import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { OURSELFdCore, TRANSITION_STATES } from "../runtime/ourselfd/core.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(".");
const token = "test-only-agentbridge-secret";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ourselfd-core-"));
}

async function gitFixture() {
  const root = await tempDir();
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "OURSELFd Tests"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "ourselfd-tests@invalid.local"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "fixture"], { cwd: root });
  return root;
}

test("reality resolution binds repository, worktree, runtime source, and pre-state", async () => {
  const stateDir = await tempDir();
  const core = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  await core.initialize();
  const instance = await core.createInstance({ purpose: "reality-binding-test" });

  assert.equal(instance.state, "INSTANCE_RESOLVED");
  assert.equal(instance.principal, "agentbridge");
  assert.equal(instance.pre_state.repository.real_path, repoRoot);
  assert.equal(instance.pre_state.repository.git_root, repoRoot);
  assert.equal(instance.pre_state.repository.head.length, 40);
  assert.equal(instance.pre_state.repository.status_hash.length, 64);
  assert.equal(instance.pre_state_hash.length, 64);
  assert.equal(instance.reality_id.length > 8, true);
  assert.equal(Object.keys(instance.pre_state.runtime.source_hashes).length, 3);
  assert.equal(core.authenticate(token), true);
  assert.equal(core.authenticate("wrong"), false);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test("repo.status is the only exposed actuator and produces a full transition receipt", async () => {
  const stateDir = await tempDir();
  const core = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  const instance = await core.createInstance({ purpose: "repo-status-test" });
  const capabilities = core.capabilities();

  assert.deepEqual(capabilities.capabilities.map((item) => item.id), ["repo.status"]);
  assert.deepEqual(capabilities.not_implemented, ["repo.read", "repo.diff"]);

  const receipt = await core.requestTransition({
    instance_id: instance.instance_id,
    pre_state_hash: instance.pre_state_hash,
    capability: "repo.status",
    operation: "git_status",
    target: ".",
    principal: "agentbridge"
  });

  assert.equal(receipt.state, "RECEIPTED");
  assert.deepEqual(receipt.states.map((item) => item.state), TRANSITION_STATES);
  assert.equal(receipt.reality_id, instance.reality_id);
  assert.equal(receipt.pre_state_hash, instance.pre_state_hash);
  assert.equal(receipt.principal, "agentbridge");
  assert.equal(receipt.authority_ref, "ourselfd.authority.agentbridge.repo-status.v1");
  assert.equal(receipt.evidence.request_hash.length, 64);
  assert.equal(receipt.evidence.observation_hash.length, 64);
  assert.match(receipt.observation.git_status, /## /);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test("instance and receipt survive daemon-core reconstruction and ledger recontact", async () => {
  const stateDir = await tempDir();
  const first = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  const instance = await first.createInstance({ purpose: "durability-test" });
  const receipt = await first.requestTransition({
    instance_id: instance.instance_id,
    pre_state_hash: instance.pre_state_hash,
    capability: "repo.status",
    operation: "git_status",
    target: "."
  });

  const second = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  const ledger = await second.initialize();
  assert.equal(ledger.integrity, "VERIFIED");
  assert.equal(ledger.event_count, 2);
  assert.deepEqual(await second.getInstance(instance.instance_id), instance);
  assert.deepEqual(await second.getReceipt(receipt.receipt_id), receipt);
  await fs.rm(stateDir, { recursive: true, force: true });
});

test("pre-state drift blocks the transition and requires a new instance", async () => {
  const root = await gitFixture();
  const stateDir = await tempDir();
  try {
    const core = new OURSELFdCore({ repoRoot: root, stateDir, authToken: token });
    const instance = await core.createInstance({ purpose: "pre-state-drift-test" });
    await fs.writeFile(path.join(root, "README.md"), "changed after instance resolution\n");

    await assert.rejects(
      core.requestTransition({
        instance_id: instance.instance_id,
        pre_state_hash: instance.pre_state_hash,
        capability: "repo.status",
        operation: "git_status",
        target: "."
      }),
      /PRE_STATE_DRIFT/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("unimplemented, forbidden, and wrong-principal requests fail closed", async () => {
  const stateDir = await tempDir();
  const core = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  const instance = await core.createInstance();

  await assert.rejects(
    core.requestTransition({ instance_id: instance.instance_id, pre_state_hash: instance.pre_state_hash, capability: "repo.diff", operation: "git_diff" }),
    /CAPABILITY_NOT_IMPLEMENTED/
  );
  await assert.rejects(
    core.requestTransition({ instance_id: instance.instance_id, pre_state_hash: instance.pre_state_hash, capability: "shell.execute", operation: "anything" }),
    /CAPABILITY_FORBIDDEN/
  );
  await assert.rejects(
    core.requestTransition({ instance_id: instance.instance_id, pre_state_hash: instance.pre_state_hash, capability: "repo.status", operation: "git_status", principal: "other-agent" }),
    /PRINCIPAL_BINDING_MISMATCH/
  );
  await fs.rm(stateDir, { recursive: true, force: true });
});

test("corrupt durable ledger fails closed instead of silently reconstructing state", async () => {
  const stateDir = await tempDir();
  const first = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  await first.createInstance({ purpose: "ledger-corruption-test" });
  const ledgerPath = path.join(stateDir, "events.jsonl");
  await fs.appendFile(ledgerPath, "{\"corrupt\":true}\n");

  const second = new OURSELFdCore({ repoRoot, stateDir, authToken: token });
  await assert.rejects(second.initialize(), /LEDGER_CORRUPT/);
  await fs.rm(stateDir, { recursive: true, force: true });
});