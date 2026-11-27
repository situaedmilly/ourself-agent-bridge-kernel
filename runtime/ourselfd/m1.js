import crypto from "node:crypto";
import path from "node:path";
import { OURSELFdCore } from "./core.js";

const repoRoot = path.resolve(process.env.OURSELF_M1_REPO_ROOT || process.cwd());
const daemonVersion = "0.1";
const sourceCommit = process.env.OURSELF_M1_SOURCE_COMMIT || process.env.GITHUB_SHA || "UNRESOLVED";

const canonicalJson = (value) => JSON.stringify(value, Object.keys(value).sort());
const sha256 = (value) =>
  crypto.createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8"
  ).digest("hex");

const daemon = new OURSELFdCore({
  repoRoot,
  requester: "ourselfd-m1"
});

const instance = daemon.createInstance({
  purpose: "OURSELFd-M1",
  mode: "QUARANTINED_RUNTIME_REALISATION",
  source_commit: sourceCommit,
  machine_residence: false,
  launchd: false,
  persistent_socket: false,
  write_access: false,
  shell_access: false,
  process_start_capability: false
});

const receipt = await daemon.requestTransition({
  instance_id: instance.instance_id,
  capability: "repo.status",
  operation: "git_status",
  target: "."
});

const observation = receipt.observation;
const observationCanonical = canonicalJson(observation);
const observationDigest = sha256(observationCanonical);

const m1Receipt = {
  receipt_version: "0.1",
  instance: {
    id: instance.instance_id,
    daemon_version: daemonVersion,
    mode: "QUARANTINED_RUNTIME_REALISATION"
  },
  transition: {
    requested: "repo.status",
    resolved: "git_status",
    request_id: receipt.request_id
  },
  state_path: receipt.states.map(({ state }) => state),
  authorization: {
    capability: "repo.status",
    write_access: false,
    shell_access: false,
    process_start: false,
    launchd: false,
    persistent_socket: false
  },
  observation,
  evidence: {
    algorithm: "SHA-256",
    subject: "canonical_observation",
    canonicalization: "JSON with lexicographically sorted top-level keys",
    digest: observationDigest
  },
  provenance: {
    source_commit: sourceCommit,
    runtime_instance: instance.instance_id,
    core_receipt_id: receipt.receipt_id
  },
  boundary: {
    build_reality: "NOT_PROVEN_BY_THIS_RECEIPT",
    runtime_reality: "PROVEN_FOR_THIS_INVOCATION",
    machine_residence: "NOT_ESTABLISHED",
    launchd_authority: "NOT_ESTABLISHED"
  },
  generated_at: new Date().toISOString()
};

process.stdout.write(JSON.stringify(m1Receipt, null, 2) + "\n");
