import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { COMMAND_ENCODING, canonicalJsonBytes, parseCanonicalJson, commandDigest } from "./command-integrity.js";

const b64u = (v) => Buffer.from(v).toString("base64url");
const decode = (v) => Buffer.from(v, "base64url");
const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const json = (v) => JSON.stringify(v);
const now = () => Math.floor(Date.now() / 1000);

function verifyJwt(token, publicKey, { issuer, audience, subject } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("JWT_MALFORMED");
  const [h, p, s] = parts;
  const header = JSON.parse(decode(h).toString("utf8"));
  const claims = JSON.parse(decode(p).toString("utf8"));
  if (header.alg !== "RS256" || header.typ !== "JWT") throw new Error("JWT_ALGORITHM_REJECTED");
  const valid = crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), publicKey, decode(s));
  if (!valid) throw new Error("JWT_SIGNATURE_INVALID");
  if (!Number.isInteger(claims.exp) || claims.exp <= now()) throw new Error("JWT_EXPIRED");
  if (claims.nbf && claims.nbf > now()) throw new Error("JWT_NOT_YET_VALID");
  if (issuer && claims.iss !== issuer) throw new Error("JWT_ISSUER_INVALID");
  if (audience && !(claims.aud === audience || Array.isArray(claims.aud) && claims.aud.includes(audience))) throw new Error("JWT_AUDIENCE_INVALID");
  if (subject && claims.sub !== subject) throw new Error("JWT_SUBJECT_INVALID");
  return claims;
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json(body));
}

function signEnvelope(payload, privateKey) {
  const bytes = canonicalJsonBytes(payload);
  const signature = crypto.sign("RSA-SHA256", bytes, privateKey).toString("base64url");
  return {
    payload,
    payload_encoding: COMMAND_ENCODING,
    payload_byte_length: bytes.length,
    payload_digest: commandDigest(bytes),
    signature,
    algorithm: "RS256"
  };
}

async function verifyDeviceRequest(req, rawBody, device, replay, pendingReplay, appendEvent) {
  const timestamp = Number(req.headers["x-ourself-timestamp"]);
  const nonce = String(req.headers["x-ourself-nonce"] || "");
  const signature = String(req.headers["x-ourself-signature"] || "");
  if (!Number.isInteger(timestamp) || Math.abs(now() - timestamp) > 30) throw new Error("DEVICE_TIMESTAMP_INVALID");
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(nonce)) throw new Error("DEVICE_NONCE_INVALID");
  const key = device.public_key;
  const message = [timestamp, nonce, sha256(rawBody)].join(".");
  if (!crypto.verify(null, Buffer.from(message), key, Buffer.from(signature, "base64url"))) throw new Error("DEVICE_SIGNATURE_INVALID");
  const replayKey = device.device_id + ":" + nonce;
  const expiry = Date.now() + 120_000;
  for (const [key, until] of replay) if (until <= Date.now()) replay.delete(key);
  if (replay.has(replayKey) || pendingReplay.has(replayKey)) throw new Error("DEVICE_REPLAY_REJECTED");
  pendingReplay.add(replayKey);
  try {
    await appendEvent({ type: "DEVICE_NONCE", replay_key: replayKey, expires_at_ms: expiry });
    replay.set(replayKey, expiry);
  } finally { pendingReplay.delete(replayKey); }
}

export function createOURTUNNELSELFServer({
  dataDir = process.env.OURTUNNELSELF_DATA_DIR || "/var/lib/ourtunnelself",
  deviceRegistryPath = process.env.OURTUNNELSELF_DEVICE_REGISTRY || "/etc/ourtunnelself/devices.json",
  brokerPrivateKeyPath = process.env.OURTUNNELSELF_BROKER_PRIVATE_KEY || "/etc/ourtunnelself/broker-private.pem",
  seatPublicKeyPath = process.env.OURTUNNELSELF_SEAT_PUBLIC_KEY || "/etc/ourtunnelself/seat-public.pem",
  portalPublicKeyPath = process.env.OURTUNNELSELF_PORTAL_PUBLIC_KEY || "/etc/ourtunnelself/portal-public.pem",
  seatIssuer = process.env.OURTUNNELSELF_SEAT_ISSUER,
  seatAudience = process.env.OURTUNNELSELF_SEAT_AUDIENCE || "ourtunnelself",
  portalIssuer = process.env.OURTUNNELSELF_PORTAL_ISSUER,
  portalAudience = process.env.OURTUNNELSELF_PORTAL_AUDIENCE || "ourtunnelself",
  host = process.env.OURTUNNELSELF_BIND || "127.0.0.1",
  port = Number(process.env.OURTUNNELSELF_PORT || 8787)
} = {}) {
  const jobs = new Map();
  const replay = new Map();
  const pendingReplay = new Set();
  const consumedPortalDecisions = new Set();
  const pendingPortalDecisions = new Set();
  let devices = new Map();
  let brokerPrivateKey, seatPublicKey, portalPublicKey;
  const journalPath = path.join(dataDir, "events.jsonl");

  async function appendEvent(event) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    const handle = await fs.open(journalPath, "a", 0o600);
    try { await handle.writeFile(json({ ...event, journaled_at: new Date().toISOString() }) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
  }

  async function load() {
    if (!seatIssuer || !portalIssuer || !seatAudience || !portalAudience) throw new Error("TRUST_ISSUER_CONFIGURATION_REQUIRED");
    [brokerPrivateKey, seatPublicKey, portalPublicKey] = await Promise.all([
      fs.readFile(brokerPrivateKeyPath, "utf8"),
      fs.readFile(seatPublicKeyPath, "utf8"),
      fs.readFile(portalPublicKeyPath, "utf8")
    ]);
    const registry = JSON.parse(await fs.readFile(deviceRegistryPath, "utf8"));
    devices = new Map((registry.devices || []).filter(d => d.enabled === true).map(d => [d.device_id, d]));
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    try {
      const lines = (await fs.readFile(journalPath, "utf8")).split("\n").filter(Boolean);
      for (const line of lines) {
        const e = JSON.parse(line);
        if (e.type === "DEVICE_NONCE" && e.expires_at_ms > Date.now()) replay.set(e.replay_key, e.expires_at_ms);
        if (e.type === "PORTAL_CONSUMED" && e.decision_jti) consumedPortalDecisions.add(e.decision_jti);
        if (e.type === "REQUESTED") {
          jobs.set(e.job.job_id, { ...e.job, status: "QUEUED" });
          if (e.job.portal_decision_jti) consumedPortalDecisions.add(e.job.portal_decision_jti);
        }
        if (e.type === "DELIVERED" && jobs.has(e.job_id)) jobs.get(e.job_id).status = "DELIVERY_UNKNOWN";
        if (e.type === "COMPLETED" && jobs.has(e.job_id)) { jobs.get(e.job_id).status = "COMPLETED"; jobs.get(e.job_id).result = e.result; }
        if (e.type === "REVOKED" && jobs.has(e.job_id)) jobs.get(e.job_id).status = "REVOKED";
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const job of jobs.values()) if (job.status === "DELIVERY_UNKNOWN") job.status = "DELIVERY_UNKNOWN";
  }

  function authenticateSeat(req, requiredScope) {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const claims = verifyJwt(token, seatPublicKey, { issuer: seatIssuer, audience: seatAudience });
    if (typeof claims.sub !== "string" || !claims.sub) throw new Error("JWT_SUBJECT_MISSING");
    const scopes = Array.isArray(claims.scope) ? claims.scope : String(claims.scope || "").split(/\s+/);
    if (!scopes.includes(requiredScope)) throw new Error("SEAT_SCOPE_DENIED");
    return claims;
  }

  function authenticatePortal(token, caller, deviceId, capability) {
    const claims = verifyJwt(token, portalPublicKey, { issuer: portalIssuer, audience: portalAudience });
    if (claims.decision !== "ADMIT") throw new Error("PORTAL_NOT_ADMITTED");
    if (claims.caller_sub !== caller.sub) throw new Error("PORTAL_CALLER_MISMATCH");
    if (claims.target_device !== deviceId) throw new Error("PORTAL_TARGET_MISMATCH");
    if (!Array.isArray(claims.admitted_capabilities) || !claims.admitted_capabilities.includes(capability)) throw new Error("PORTAL_CAPABILITY_MISMATCH");
    if (!claims.authority_grant_ref || !claims.policy_version || typeof claims.jti !== "string" || !claims.jti) throw new Error("PORTAL_EVIDENCE_INCOMPLETE");
    return claims;
  }

  function currentJobStatus(job) {
    if (job.status === "QUEUED" && job.expires_at <= now()) return "EXPIRED";
    return job.status;
  }

  function findPriorPortalJob(portal, caller, deviceId, capability, operation, purpose, target) {
    const prior = [...jobs.values()].find(job => job.portal_decision_jti === portal.jti);
    if (!prior) return null;
    const sameRequest = prior.caller_sub === caller.sub &&
      prior.device_id === deviceId && prior.capability === capability &&
      prior.operation === operation && prior.purpose === purpose && prior.target === target;
    if (!sameRequest) throw new Error("PORTAL_REPLAY_REJECTED");
    return prior;
  }

  async function recordRequestedJob(job, portal) {
    const decisionId = portal.jti;
    if (consumedPortalDecisions.has(decisionId) || pendingPortalDecisions.has(decisionId)) throw new Error("PORTAL_REPLAY_REJECTED");
    pendingPortalDecisions.add(decisionId);
    try {
      const envelope = signEnvelope(job, brokerPrivateKey);
      await appendEvent({ type: "REQUESTED", job: { ...job, envelope } });
      consumedPortalDecisions.add(decisionId);
      const stored = { ...job, envelope, status: "QUEUED" };
      jobs.set(job.job_id, stored);
      return stored;
    } finally { pendingPortalDecisions.delete(decisionId); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/mcp") {
        const rpc = JSON.parse((await readBody(req)).toString("utf8"));
        const reply = result => send(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, result });
        const rpcError = (code, message) => send(res, 200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
        if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return rpcError(-32600, "Invalid JSON-RPC request");
        if (rpc.method === "initialize") return reply({
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "OURSELF DESKTOP COMMANDER", version: "0.1.0" }
        });
        if (rpc.method === "notifications/initialized") return send(res, 202, null);
        if (rpc.method === "ping") return reply({});
        if (rpc.method === "tools/list") {
          authenticateSeat(req, "ourself:device:read");
          return reply({ tools: [
            { name: "ourself_list_devices", description: "List enrolled OURSELF devices; does not imply connectivity or admission.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
            { name: "ourself_request_repo_status", description: "Request a read-only git status operation after independent signed PORTAL admission.", inputSchema: { type: "object", required: ["device_id", "portal_admission", "purpose"], properties: { device_id: { type: "string" }, portal_admission: { type: "string" }, purpose: { type: "string", maxLength: 512 }, target: { type: "string" } }, additionalProperties: false } },
            { name: "ourself_get_job", description: "Read the status and result of a request created by this caller.", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } }, additionalProperties: false } }
          ] });
        }
        if (rpc.method === "tools/call") {
          const name = rpc.params?.name;
          const args = rpc.params?.arguments || {};
          let value;
          if (name === "ourself_list_devices") {
            authenticateSeat(req, "ourself:device:read");
            value = { devices: [...devices.values()].map(d => ({ device_id: d.device_id, label: d.label, enabled: d.enabled === true })) };
          } else if (name === "ourself_request_repo_status") {
            const caller = authenticateSeat(req, "ourself:repo:status");
            if (typeof args.device_id !== "string" || typeof args.portal_admission !== "string" || typeof args.purpose !== "string") return rpcError(-32602, "device_id, portal_admission and purpose are required");
            if (!devices.has(args.device_id)) throw new Error("DEVICE_NOT_ADMITTED");
            if (args.target !== undefined && args.target !== ".") throw new Error("TARGET_NOT_ADMITTED");
            const portal = authenticatePortal(args.portal_admission, caller, args.device_id, "repo.status");
            const job = {
              job_id: crypto.randomUUID(), device_id: args.device_id, caller_sub: caller.sub,
              capability: "repo.status", operation: "git_status", target: typeof args.target === "string" ? args.target : ".",
              purpose: args.purpose.slice(0, 512), portal_decision_jti: portal.jti || null,
              portal_admission: args.portal_admission,
              authority_grant_ref: portal.authority_grant_ref, policy_version: portal.policy_version,
              expires_at: Math.min(Number(portal.exp), now() + 120), created_at: new Date().toISOString()
            };
            if (!job.purpose) throw new Error("PURPOSE_REQUIRED");
            const prior = findPriorPortalJob(portal, caller, job.device_id, job.capability, job.operation, job.purpose, job.target);
            if (prior) {
              value = { job_id: prior.job_id, status: currentJobStatus(prior), expires_at: prior.expires_at, idempotent_replay: true };
              return reply({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
            }
            const stored = await recordRequestedJob(job, portal);
            value = { job_id: stored.job_id, status: stored.status, expires_at: stored.expires_at };
          } else if (name === "ourself_get_job") {
            const caller = authenticateSeat(req, "ourself:repo:status");
            const job = jobs.get(String(args.job_id || ""));
            if (!job || job.caller_sub !== caller.sub) throw new Error("JOB_NOT_FOUND");
            value = { job_id: job.job_id, status: currentJobStatus(job), result: job.result || null };
          } else {
            return rpcError(-32602, "Unknown tool");
          }
          return reply({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: false });
        }
        return rpcError(-32601, "Method not found");
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { service: "OURTUNNELSELF", state: "READY", device_count: devices.size, authority: "NONE_BY_TRANSPORT" });
      }

      if (req.method === "GET" && url.pathname === "/v1/seat/devices") {
        authenticateSeat(req, "ourself:device:read");
        return send(res, 200, { devices: [...devices.values()].map(d => ({ device_id: d.device_id, label: d.label, enabled: d.enabled === true })) });
      }

      if (req.method === "POST" && url.pathname === "/v1/seat/requests") {
        const caller = authenticateSeat(req, "ourself:repo:status");
        const body = parseCanonicalJson(await readBody(req));
        if (body.capability !== "repo.status" || body.operation !== "git_status") throw new Error("CAPABILITY_NOT_IMPLEMENTED");
        if (body.target !== undefined && body.target !== ".") throw new Error("TARGET_NOT_ADMITTED");
        if (!devices.has(body.device_id)) throw new Error("DEVICE_NOT_ADMITTED");
        const portal = authenticatePortal(body.portal_admission, caller, body.device_id, body.capability);
        const job = {
          job_id: crypto.randomUUID(),
          device_id: body.device_id,
          caller_sub: caller.sub,
          capability: body.capability,
          operation: body.operation,
          target: typeof body.target === "string" ? body.target : ".",
          purpose: String(body.purpose || "").slice(0, 512),
          portal_decision_jti: portal.jti || null,
          portal_admission: body.portal_admission,
          authority_grant_ref: portal.authority_grant_ref,
          policy_version: portal.policy_version,
          expires_at: Math.min(Number(portal.exp), now() + 120),
          created_at: new Date().toISOString()
        };
        if (!job.purpose) throw new Error("PURPOSE_REQUIRED");
        const prior = findPriorPortalJob(portal, caller, job.device_id, job.capability, job.operation, job.purpose, job.target);
        if (prior) return send(res, 202, { job_id: prior.job_id, status: prior.status, expires_at: prior.expires_at, idempotent_replay: true });
        const stored = await recordRequestedJob(job, portal);
        return send(res, 202, { job_id: stored.job_id, status: stored.status, expires_at: stored.expires_at });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/seat/requests/")) {
        const caller = authenticateSeat(req, "ourself:repo:status");
        const jobId = url.pathname.split("/").pop();
        const job = jobs.get(jobId);
        if (!job || job.caller_sub !== caller.sub) return send(res, 404, { error: "JOB_NOT_FOUND" });
        return send(res, 200, { job_id: job.job_id, status: currentJobStatus(job), result: job.result || null });
      }

      if (req.method === "POST" && ["/v1/device/poll", "/v1/device/result"].includes(url.pathname)) {
        const raw = await readBody(req);
        const deviceId = String(req.headers["x-ourself-device"] || "");
        const device = devices.get(deviceId);
        if (!device) throw new Error("DEVICE_NOT_ADMITTED");
        await verifyDeviceRequest(req, raw, device, replay, pendingReplay, appendEvent);
        if (url.pathname === "/v1/device/poll") {
          const job = [...jobs.values()].find(j => j.device_id === deviceId && j.status === "QUEUED" && j.expires_at > now());
          if (!job) return send(res, 204, null);
          await appendEvent({ type: "DELIVERED", job_id: job.job_id, device_id: deviceId, device_timestamp: req.headers["x-ourself-timestamp"], device_nonce: req.headers["x-ourself-nonce"], device_signature: req.headers["x-ourself-signature"] });
          job.status = "DELIVERY_UNKNOWN";
          return send(res, 200, job.envelope);
        }
        const result = parseCanonicalJson(raw);
        const job = jobs.get(result.job_id);
        if (!job || job.device_id !== deviceId || job.status !== "DELIVERY_UNKNOWN") throw new Error("JOB_STATE_INVALID");
        if (job.expires_at <= now()) throw new Error("JOB_EXPIRED");
        await appendEvent({ type: "COMPLETED", job_id: job.job_id, result, device_timestamp: req.headers["x-ourself-timestamp"], device_nonce: req.headers["x-ourself-nonce"], device_signature: req.headers["x-ourself-signature"] });
        job.status = "COMPLETED";
        job.result = result;
        return send(res, 200, { accepted: true, job_id: job.job_id });
      }

      return send(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const status = /JWT_|SIGNATURE|REPLAY|SCOPE|PORTAL_|DEVICE_|CAPABILITY_|JOB_|PURPOSE_/.test(error.message) ? 403 : 400;
      return send(res, status, { error: error.message });
    }
  });

  return {
    server,
    async start() { await load(); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); return { host, port, devices: devices.size }; },
    async stop() { await new Promise(resolve => server.close(resolve)); }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const app = createOURTUNNELSELFServer();
  await app.start();
  console.log(JSON.stringify({ service: "OURTUNNELSELF", state: "LISTENING", bind: process.env.OURTUNNELSELF_BIND || "127.0.0.1", port: Number(process.env.OURTUNNELSELF_PORT || 8787) }));
}
