import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(CORE_DIR, "../../contracts/ourselfd-capabilities.v0.2.json");
const ZERO_HASH = "0".repeat(64);
const AUTHORITY_REF = "ourselfd.authority.agentbridge.repo-status.v1";

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
  "repo.status": Object.freeze({
    id: "repo.status",
    mutability: "read",
    exposed: true,
    operation: "git_status",
    receipt_required: true
  })
});

export const NOT_IMPLEMENTED_CAPABILITIES = Object.freeze(["repo.read", "repo.diff"]);

export const EXPLICITLY_ABSENT = Object.freeze([
  "shell.execute",
  "process.start",
  "repo.write",
  "file.write",
  "arbitrary_filesystem_access"
]);

const AUTHORIZED_OPERATIONS = Object.freeze({
  "agentbridge": Object.freeze({
    "repo.status": Object.freeze(["git_status"])
  })
});

const now = () => new Date().toISOString();
const id = (prefix) => prefix + "-" + crypto.randomUUID();

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])
  ).join(",") + "}";
}

function digest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function clone(value) {
  return structuredClone(value);
}

function transition(record, state) {
  record.states.push({ state, at: now() });
  record.state = state;
}

async function readBootId() {
  try {
    return (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } catch {
    return null;
  }
}

export class OURSELFdCore {
  constructor({
    repoRoot,
    stateDir = path.join(os.homedir(), ".local", "state", "ourselfd"),
    authToken,
    principal = "agentbridge"
  } = {}) {
    if (!repoRoot) throw new Error("REPO_ROOT_REQUIRED");
    if (!path.isAbsolute(stateDir)) throw new Error("STATE_DIR_MUST_BE_ABSOLUTE");
    if (principal !== "agentbridge") throw new Error("PRINCIPAL_NOT_ADMITTED");

    this.repoRoot = path.resolve(repoRoot);
    this.stateDir = path.resolve(stateDir);
    this.ledgerPath = path.join(this.stateDir, "events.jsonl");
    this.authTokenHash = typeof authToken === "string" && authToken.length > 0
      ? digest(authToken)
      : null;
    this.principal = principal;
    this.instances = new Map();
    this.receipts = new Map();
    this.sequence = 0;
    this.lastEventHash = ZERO_HASH;
    this.initialized = false;
    this.initializing = null;
  }

  async initialize() {
    if (this.initialized) return this.ledgerStatus();
    if (this.initializing) return this.initializing;
    this.initializing = this.#loadLedger();
    try {
      const result = await this.initializing;
      this.initialized = true;
      return result;
    } finally {
      this.initializing = null;
    }
  }

  authenticate(token) {
    if (!this.authTokenHash || typeof token !== "string" || token.length === 0) return false;
    const presented = Buffer.from(digest(token), "hex");
    const expected = Buffer.from(this.authTokenHash, "hex");
    return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
  }

  capabilities() {
    return {
      authority: "OURSELFd",
      principal: this.principal,
      capabilities: Object.values(CAPABILITIES).map((capability) => ({
        ...capability,
        authorized_requesters: [this.principal]
      })),
      not_implemented: [...NOT_IMPLEMENTED_CAPABILITIES],
      explicitly_absent: [...EXPLICITLY_ABSENT]
    };
  }

  ledgerStatus() {
    return {
      integrity: "VERIFIED",
      event_count: this.sequence,
      head_hash: this.lastEventHash,
      storage: this.ledgerPath
    };
  }

  async #loadLedger() {
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.stateDir, 0o700);
    let raw = "";
    try {
      raw = await fs.readFile(this.ledgerPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    let expectedSequence = 1;
    let previousHash = ZERO_HASH;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new Error("LEDGER_CORRUPT:INVALID_JSON");
      }
      const { event_hash: eventHash, ...base } = event;
      if (event.sequence !== expectedSequence || event.previous_hash !== previousHash) {
        throw new Error("LEDGER_CORRUPT:CHAIN_DISCONTINUITY");
      }
      if (event.record_hash !== digest(event.record) || eventHash !== digest(base)) {
        throw new Error("LEDGER_CORRUPT:HASH_MISMATCH");
      }
      if (event.type === "INSTANCE_CREATED") this.instances.set(event.record.instance_id, event.record);
      else if (event.type === "RECEIPT_PERSISTED") this.receipts.set(event.record.receipt_id, event.record);
      else throw new Error("LEDGER_CORRUPT:UNKNOWN_EVENT");
      expectedSequence += 1;
      previousHash = eventHash;
    }

    this.sequence = expectedSequence - 1;
    this.lastEventHash = previousHash;
    return this.ledgerStatus();
  }

  async #appendEvent(type, record) {
    const base = {
      sequence: this.sequence + 1,
      type,
      at: now(),
      previous_hash: this.lastEventHash,
      record_hash: digest(record),
      record
    };
    const event = { ...base, event_hash: digest(base) };
    const handle = await fs.open(this.ledgerPath, "a", 0o600);
    try {
      await handle.writeFile(JSON.stringify(event) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.sequence = event.sequence;
    this.lastEventHash = event.event_hash;
  }

  async #resolvePreState() {
    const repoRealPath = await fs.realpath(this.repoRoot);
    const runGit = async (args) => {
      const result = await execFileAsync("git", args, {
        cwd: repoRealPath,
        timeout: 7000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env
      });
      return result.stdout.trimEnd();
    };

    let gitRoot;
    let head;
    let branch;
    let status;
    try {
      gitRoot = await fs.realpath(await runGit(["rev-parse", "--show-toplevel"]));
      head = await runGit(["rev-parse", "HEAD"]);
      branch = await runGit(["branch", "--show-current"]);
      status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
    } catch {
      throw new Error("REALITY_RESOLUTION_FAILED");
    }
    if (gitRoot !== repoRealPath) throw new Error("REPO_ROOT_NOT_GIT_ROOT");

    const sourcePaths = [
      path.join(CORE_DIR, "core.js"),
      path.join(CORE_DIR, "daemon.js"),
      CONTRACT_PATH
    ];
    const sourceHashes = {};
    for (const sourcePath of sourcePaths) {
      const relative = path.relative(repoRealPath, sourcePath);
      sourceHashes[relative] = crypto.createHash("sha256")
        .update(await fs.readFile(sourcePath))
        .digest("hex");
    }

    const contract = await fs.readFile(CONTRACT_PATH, "utf8");
    const bootId = await readBootId();
    const repository = {
      real_path: repoRealPath,
      git_root: gitRoot,
      head,
      branch,
      dirty: status.length > 0,
      status_hash: crypto.createHash("sha256").update(status).digest("hex")
    };
    const runtime = {
      host: os.hostname(),
      boot_id: bootId,
      source_hashes: sourceHashes,
      capability_contract_hash: crypto.createHash("sha256").update(contract).digest("hex")
    };
    const reality_id = "reality-" + digest({
      host: runtime.host,
      boot_id: runtime.boot_id,
      repository: repository.real_path,
      head: repository.head,
      branch: repository.branch,
      source_hashes: runtime.source_hashes,
      capability_contract_hash: runtime.capability_contract_hash
    });
    return {
      reality_id,
      repository,
      runtime,
      authority_ref: AUTHORITY_REF
    };
  }

  async createInstance(metadata = {}, principal = this.principal) {
    await this.initialize();
    if (principal !== this.principal) throw new Error("PRINCIPAL_NOT_ADMITTED");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error("INSTANCE_METADATA_INVALID");
    }
    const preState = await this.#resolvePreState();
    const instance = {
      instance_id: id("instance"),
      state: "INSTANCE_RESOLVED",
      principal,
      identity: {
        authenticated_principal: principal,
        binding: "CONFIGURED_SHARED_SECRET",
        authority_ref: AUTHORITY_REF
      },
      runtime: {
        host: os.hostname(),
        pid: process.pid,
        boot_id: preState.runtime.boot_id
      },
      reality_id: preState.reality_id,
      pre_state: preState,
      pre_state_hash: digest(preState),
      lineage: { parent_instance: null, reality_id: preState.reality_id },
      metadata: clone(metadata),
      created_at: now(),
      resolved_at: now()
    };
    await this.#appendEvent("INSTANCE_CREATED", instance);
    this.instances.set(instance.instance_id, instance);
    return clone(instance);
  }

  async getInstance(instanceId) {
    await this.initialize();
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error("INSTANCE_NOT_FOUND");
    return clone(instance);
  }

  async requestTransition({
    instance_id,
    capability,
    operation,
    target = ".",
    pre_state_hash,
    principal = this.principal
  } = {}) {
    await this.initialize();
    const record = {
      request_id: id("request"),
      instance_id,
      capability,
      operation,
      target,
      principal,
      authority_ref: AUTHORITY_REF,
      state: null,
      states: [],
      requested_at: now()
    };
    transition(record, "REQUESTED");

    const instance = this.instances.get(instance_id);
    if (!instance) throw new Error("INSTANCE_NOT_FOUND");
    if (principal !== this.principal || instance.principal !== principal) {
      throw new Error("PRINCIPAL_BINDING_MISMATCH");
    }
    transition(record, "RESOLVED");

    if (!CAPABILITIES[capability]) {
      if (NOT_IMPLEMENTED_CAPABILITIES.includes(capability)) throw new Error("CAPABILITY_NOT_IMPLEMENTED");
      if (EXPLICITLY_ABSENT.includes(capability)) throw new Error("CAPABILITY_FORBIDDEN");
      throw new Error("CAPABILITY_NOT_FOUND");
    }
    if (typeof operation !== "string" || !operation.trim() || operation !== operation.trim()) {
      throw new Error("OPERATION_INVALID");
    }
    if (!AUTHORIZED_OPERATIONS[principal]?.[capability]?.includes(operation)) {
      throw new Error("AUTHORITY_DENIED");
    }
    if (target !== "." && target !== this.repoRoot && target !== instance.pre_state.repository.real_path) {
      throw new Error("TARGET_NOT_ADMITTED");
    }
    if (typeof pre_state_hash !== "string" || pre_state_hash !== instance.pre_state_hash) {
      throw new Error("PRE_STATE_BINDING_REQUIRED");
    }
    transition(record, "AUTHENTICATED");
    transition(record, "AUTHORIZED");

    const currentPreState = await this.#resolvePreState();
    if (digest(currentPreState) !== instance.pre_state_hash) throw new Error("PRE_STATE_DRIFT");
    transition(record, "PRECONDITIONS_SATISFIED");
    transition(record, "ADMITTED");
    transition(record, "ACTUATED");

    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--branch", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: instance.pre_state.repository.real_path,
        timeout: 7000,
        maxBuffer: 2 * 1024 * 1024
      }
    );
    const observation = {
      repository: instance.pre_state.repository.real_path,
      head: instance.pre_state.repository.head,
      git_status: stdout
    };
    transition(record, "OBSERVED");

    const receipt = {
      receipt_id: id("receipt"),
      request_id: record.request_id,
      instance_id,
      reality_id: instance.reality_id,
      pre_state_hash: instance.pre_state_hash,
      principal,
      capability,
      operation,
      target: ".",
      authority_ref: AUTHORITY_REF,
      state: "RECEIPTED",
      observation,
      evidence: {
        request_hash: digest({
          request_id: record.request_id,
          instance_id,
          reality_id: instance.reality_id,
          pre_state_hash: instance.pre_state_hash,
          principal,
          capability,
          operation,
          target: "."
        }),
        observation_hash: digest(observation)
      },
      lineage: {
        parent_instance: instance.lineage.parent_instance,
        instance_id,
        reality_id: instance.reality_id,
        transition_id: record.request_id
      },
      states: [...record.states, { state: "RECEIPTED", at: now() }],
      created_at: now()
    };

    await this.#appendEvent("RECEIPT_PERSISTED", receipt);
    this.receipts.set(receipt.receipt_id, receipt);
    return clone(receipt);
  }

  async getReceipt(receiptId) {
    await this.initialize();
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
    return clone(receipt);
  }
}