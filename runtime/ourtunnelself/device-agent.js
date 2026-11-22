import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const b64u = v => Buffer.from(v).toString("base64url");
const sha256 = v => crypto.createHash("sha256").update(v).digest("hex");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function verifyBrokerEnvelope(envelope, publicKey) {
  if (!envelope || envelope.algorithm !== "RS256" || !envelope.payload || !envelope.signature) throw new Error("BROKER_ENVELOPE_INVALID");
  const body = b64u(JSON.stringify(envelope.payload));
  if (!crypto.verify("RSA-SHA256", Buffer.from(body), publicKey, Buffer.from(envelope.signature, "base64url"))) throw new Error("BROKER_SIGNATURE_INVALID");
  const p = envelope.payload;
  if (p.device_id !== process.env.OURTUNNELSELF_DEVICE_ID) throw new Error("WRONG_DEVICE_TARGET");
  if (!Number.isInteger(p.expires_at) || p.expires_at <= Math.floor(Date.now() / 1000)) throw new Error("JOB_EXPIRED");
  if (p.capability !== "repo.status" || p.operation !== "git_status") throw new Error("CAPABILITY_NOT_ADMITTED");
  if (!p.authority_grant_ref || !p.policy_version) throw new Error("AUTHORITY_EVIDENCE_MISSING");
  return p;
}

function socketRequest(socketPath, method, route, body) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({ socketPath, path: route, method, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(raw) } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { return reject(new Error("OURSELFD_RESPONSE_INVALID")); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed?.error || "OURSELFD_REQUEST_FAILED"));
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.end(raw);
  });
}

function signedHeaders(methodBody, deviceId, privateKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const message = [timestamp, nonce, sha256(methodBody)].join(".");
  const signature = crypto.sign(null, Buffer.from(message), privateKey).toString("base64url");
  return { "x-ourself-device": deviceId, "x-ourself-timestamp": String(timestamp), "x-ourself-nonce": nonce, "x-ourself-signature": signature };
}

function brokerRequest(baseUrl, route, rawBody, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(route, baseUrl);
    if (target.protocol !== "https:" && process.env.OURTUNNELSELF_ALLOW_INSECURE !== "1") return reject(new Error("BROKER_HTTPS_REQUIRED"));
    const req = http.request({
      protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search, method: "POST", headers: { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(rawBody) },
      ...(target.protocol === "https:" ? { agent: undefined } : {})
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 204) return resolve(null);
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; } catch { return reject(new Error("BROKER_RESPONSE_INVALID")); }
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(parsed?.error || "BROKER_REQUEST_FAILED"));
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.end(rawBody);
  });
}

export async function runOURTUNNELSELFDeviceAgent({
  brokerUrl = process.env.OURTUNNELSELF_BROKER_URL,
  deviceId = process.env.OURTUNNELSELF_DEVICE_ID,
  privateKeyPath = process.env.OURTUNNELSELF_DEVICE_PRIVATE_KEY,
  brokerPublicKeyPath = process.env.OURTUNNELSELF_BROKER_PUBLIC_KEY,
  socketPath = process.env.OURSELFD_SOCKET || "/var/tmp/ourselfd.sock",
  journalPath = process.env.OURTUNNELSELF_AGENT_JOURNAL || path.join(process.env.HOME || ".", ".ourself", "ourtunnelself-agent.jsonl")
} = {}) {
  if (!brokerUrl || !deviceId || !privateKeyPath || !brokerPublicKeyPath) throw new Error("DEVICE_AGENT_CONFIGURATION_INCOMPLETE");
  const privateKey = await fs.readFile(privateKeyPath, "utf8");
  const brokerPublicKey = await fs.readFile(brokerPublicKeyPath, "utf8");
  const seen = new Set();
  try {
    const lines = (await fs.readFile(journalPath, "utf8")).split("\n").filter(Boolean);
    for (const line of lines) { const e = JSON.parse(line); if (e.job_id) seen.add(e.job_id); }
  } catch (e) { if (e.code !== "ENOENT") throw e; }

  async function append(record) {
    await fs.mkdir(path.dirname(journalPath), { recursive: true, mode: 0o700 });
    const h = await fs.open(journalPath, "a", 0o600);
    try { await h.writeFile(JSON.stringify({ ...record, at: new Date().toISOString() }) + "\n"); await h.sync(); }
    finally { await h.close(); }
  }

  let stopping = false;
  const stop = () => { stopping = true; };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  while (!stopping) {
    try {
      const empty = "";
      const headers = signedHeaders(empty, deviceId, privateKey);
      const envelope = await brokerRequest(brokerUrl, "/v1/device/poll", empty, headers);
      if (!envelope) { await sleep(2500); continue; }
      const job = verifyBrokerEnvelope(envelope, brokerPublicKey);
      if (seen.has(job.job_id)) {
        await append({ job_id: job.job_id, state: "DUPLICATE_SUPPRESSED" });
        continue;
      }
      let result;
      try {
        const instance = await socketRequest(socketPath, "POST", "/v1/instances", { purpose: job.purpose, remote_job_id: job.job_id });
        const receipt = await socketRequest(socketPath, "POST", "/v1/transitions/request", {
          instance_id: instance.instance_id, capability: job.capability, operation: job.operation, target: job.target
        });
        result = { job_id: job.job_id, state: "EXECUTED", local_receipt: receipt };
      } catch (error) {
        result = { job_id: job.job_id, state: "FAILED", error: String(error.message || error).slice(0, 256) };
      }
      await append({ job_id: job.job_id, state: result.state, local_receipt_id: result.local_receipt?.receipt_id || null });
      seen.add(job.job_id);
      const raw = JSON.stringify(result);
      await brokerRequest(brokerUrl, "/v1/device/result", raw, signedHeaders(raw, deviceId, privateKey));
    } catch (error) {
      if (stopping) break;
      process.stderr.write(JSON.stringify({ service: "OURTUNNELSELF-device-agent", error: String(error.message || error) }) + "\n");
      await sleep(5000);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await runOURTUNNELSELFDeviceAgent();
}
