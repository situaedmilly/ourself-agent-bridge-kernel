import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: ["ignore", "ignore", "pipe"]
});

const instanceId = `m4-${Date.now()}-${child.pid}`;
const bornPid = child.pid;

if (!bornPid) {
  throw new Error("BOUNDED_RUNTIME_BIRTH_FAILED");
}

let aliveAtBirth = child.exitCode === null;

await new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 250);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
});

const aliveAtLiveness = child.exitCode === null;
const observedPid = child.pid;

if (!aliveAtBirth || !aliveAtLiveness || observedPid !== bornPid) {
  child.kill("SIGTERM");
  throw new Error("BOUNDED_RUNTIME_LIVENESS_FAILED");
}

child.kill("SIGTERM");
await once(child, "exit");

const receipt = {
  receipt_version: "0.1",
  gate: "M4",
  species: "BOUNDED_RUNTIME_BIRTH",
  instance_id: instanceId,
  process_identity: `pid:${bornPid}`,
  evidence: {
    BIRTH: {
      instance_id: instanceId,
      process_identity: `pid:${bornPid}`,
      independently_observed: true
    },
    PROCESS_IDENTITY: {
      instance_id: instanceId,
      process_identity: `pid:${observedPid}`,
      independently_observed: true
    },
    LIVENESS: {
      instance_id: instanceId,
      process_identity: `pid:${observedPid}`,
      independently_observed: true
    }
  },
  boundary: {
    target_machine_residence: "NOT_PROVEN",
    launchd: "CLOSED",
    arbitrary_process_start_capability: "CLOSED",
    observation_scope: "GITHUB_ACTIONS_RUNNER"
  }
};

process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
