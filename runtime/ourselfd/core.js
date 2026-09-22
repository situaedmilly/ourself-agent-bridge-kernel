import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TRANSITION_STATES = Object.freeze([
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

export const CAPABILITIES = Object.freeze({
  "repo.read": Object.freeze({
    id: "repo.read",
    mutability: "read",
    exposed: false,
    implementation_status: "DECLARED_NOT_IMPLEMENTED"
  }),
  "repo.status": Object.freeze({
    id: "repo.status",
    mutability: "read",
    exposed: true,
    implementation_status: "IMPLEMENTED"
  }),
  "repo.diff": Object.freeze({
    id: "repo.diff",
    mutability: "read",
    exposed: false,
    implementation_status: "DECLARED_NOT_IMPLEMENTED"
  })
});

const FORBIDDEN_CAPABILITIES = new Set([
  "shell.execute",
  "process.start",
  "repo.write",
  "file.write",
  "arbitrary_filesystem_access"
]);

const OPERATIONS = Object.freeze({
  "repo.status": new Set(["git_status"])
});

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const sha256 = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function assertCapability(name) {
  if (FORBIDDEN_CAPABILITIES.has(name)) {
    throw new Error(`CAPABILITY_FORBIDDEN:${name}`);
  }
  if (!CAPABILITIES[name]) {
    throw new Error(`CAPABILITY_NOT_FOUND:${name}`);
  }
}

function transition(record, state) {
  record.states.push({ state, at: now() });
  record.state = state;
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class OURSELFdCore {
  constructor({ repoRoot, requester = "local-client", receiptDir = null } = {}) {
    if (!repoRoot) throw new Error("repoRoot is required");
    this.repoRoot = path.resolve(repoRoot);
    this.requester = requester;
    this.receiptDir = receiptDir ? path.resolve(receiptDir) : null;
    this.instances = new Map();
    this.receipts = new Map();
  }

  capabilities() {
    return Object.values(CAPABILITIES).map((capability) => ({
      ...capability,
      authorized_requesters: [this.requester]
    }));
  }

  createInstance(metadata = {}) {
    const instance = {
      instance_id: id("instance"),
      state: "INSTANCE_CREATED",
      created_at: now(),
      observed_at: null,
      resolved_at: null,
      metadata: structuredClone(metadata)
    };

    this.instances.set(instance.instance_id, instance);

    instance.state = "INSTANCE_OBSERVED";
    instance.observed_at = now();
    instance.state = "INSTANCE_RESOLVED";
    instance.resolved_at = now();

    return structuredClone(instance);
  }

  getInstance(instanceId) {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error("INSTANCE_NOT_FOUND");
    return structuredClone(instance);
  }

  async requestTransition({ instance_id, capability, operation, target }) {
    const record = {
      request_id: id("request"),
      instance_id,
      capability,
      operation,
      target,
      requester: this.requester,
      state: null,
      states: [],
      requested_at: now()
    };

    transition(record, "REQUESTED");

    const instance = this.instances.get(instance_id);
    if (!instance) throw new Error("INSTANCE_NOT_FOUND");
    transition(record, "RESOLVED");

    assertCapability(capability);

    if (typeof operation !== "string" || !operation.trim() || operation !== operation.trim()) {
      throw new Error("OPERATION_INVALID");
    }

    if (!OPERATIONS[capability]?.has(operation)) {
      throw new Error("OPERATION_NOT_IMPLEMENTED");
    }

    transition(record, "AUTHENTICATED");
    transition(record, "AUTHORIZED");

    const targetRoot = path.resolve(this.repoRoot);
    const requestedTarget = target ? path.resolve(targetRoot, target) : targetRoot;

    if (!isWithinRoot(requestedTarget, targetRoot)) {
      throw new Error("TARGET_OUTSIDE_REPOSITORY");
    }

    await fs.access(requestedTarget);
    transition(record, "PRECONDITIONS_SATISFIED");
    transition(record, "ADMITTED");

    transition(record, "ACTUATED");

    let observation;
    if (capability === "repo.status" && operation === "git_status") {
      observation = await this.#repoStatus(requestedTarget);
    }

    transition(record, "OBSERVED");

    const receipt = {
      receipt_id: id("receipt"),
      request_id: record.request_id,
      instance_id,
      capability,
      operation,
      target: target || ".",
      state: "RECEIPTED",
      observation,
      evidence: {
        request_hash: sha256({
          request_id: record.request_id,
          instance_id,
          capability,
          operation,
          target: target || "."
        }),
        observation_hash: sha256(observation)
      },
      lineage: {
        parent_instance: null,
        transition_id: record.request_id
      },
      states: [...record.states, { state: "RECEIPTED", at: now() }],
      created_at: now()
    };

    this.receipts.set(receipt.receipt_id, receipt);

    if (this.receiptDir) {
      await fs.mkdir(this.receiptDir, { recursive: true });
      await fs.writeFile(
        path.join(this.receiptDir, `${receipt.receipt_id}.json`),
        JSON.stringify(receipt, null, 2) + "\n",
        { mode: 0o600 }
      );
    }

    return structuredClone(receipt);
  }

  async recontactReceipt(receiptId) {
    const inMemory = this.receipts.get(receiptId);
    if (inMemory) return structuredClone(inMemory);
    if (!this.receiptDir) throw new Error("RECEIPT_NOT_FOUND");
    const file = path.join(this.receiptDir, `${receiptId}.json`);
    try {
      const raw = await fs.readFile(file, "utf8");
      const receipt = JSON.parse(raw);
      this.receipts.set(receiptId, receipt);
      return structuredClone(receipt);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("RECEIPT_NOT_FOUND");
      throw error;
    }
  }

  getReceipt(receiptId) {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
    return structuredClone(receipt);
  }

  async #repoStatus(repoPath) {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--branch", "--porcelain=v1"],
      {
        cwd: repoPath,
        timeout: 5000,
        maxBuffer: 1024 * 1024
      }
    );

    return {
      repository: repoPath,
      git_status: stdout
    };
  }
}
