import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createOURTUNNELSELFServer } from "../runtime/ourtunnelself/broker.js";

const b64u = value => Buffer.from(JSON.stringify(value)).toString("base64url");
function signJwt(claims, privateKey) {
  const input = b64u({ alg: "RS256", typ: "JWT" }) + "." + b64u(claims);
  return input + "." + crypto.sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}
function deviceHeaders(body, deviceId, privateKey) {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(24).toString("base64url");
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const signature = crypto.sign(null, Buffer.from([timestamp, nonce, digest].join(".")), privateKey).toString("base64url");
  return { "x-ourself-device": deviceId, "x-ourself-timestamp": String(timestamp), "x-ourself-nonce": nonce, "x-ourself-signature": signature, "content-type": "application/json" };
}

test("broker requires signed seat and PORTAL authority, binds device, and does not replay uncertain delivery", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ourtunnelself-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const brokerKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const seatKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const portalKeys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const deviceKeys = crypto.generateKeyPairSync("ed25519");
  const writeKey = async (name, key) => {
    const file = path.join(root, name);
    await fs.writeFile(file, key, { mode: 0o600 });
    return file;
  };
  const brokerPrivate = await writeKey("broker-private.pem", brokerKeys.privateKey.export({ type: "pkcs8", format: "pem" }));
  const seatPublic = await writeKey("seat-public.pem", seatKeys.publicKey.export({ type: "spki", format: "pem" }));
  const portalPublic = await writeKey("portal-public.pem", portalKeys.publicKey.export({ type: "spki", format: "pem" }));
  const deviceId = "OURSELFMAC.local";
  const registry = path.join(root, "devices.json");
  await fs.writeFile(registry, JSON.stringify({ devices: [{
    device_id: deviceId,
    label: "Mac test device",
    enabled: true,
    public_key: deviceKeys.publicKey.export({ type: "spki", format: "pem" }).toString()
  }] }));
  const app = createOURTUNNELSELFServer({
    dataDir: path.join(root, "data"),
    deviceRegistryPath: registry,
    brokerPrivateKeyPath: brokerPrivate,
    seatPublicKeyPath: seatPublic,
    portalPublicKeyPath: portalPublic,
    seatIssuer: "https://osos.example/seat",
    seatAudience: "ourtunnelself",
    portalIssuer: "https://portal.example/admission",
    portalAudience: "ourtunnelself",
    host: "127.0.0.1",
    port: 0
  });
  await app.start();
  t.after(() => app.stop());
  const base = "http://127.0.0.1:" + app.server.address().port;
  const seatToken = signJwt({
    iss: "https://osos.example/seat", aud: "ourtunnelself", sub: "operator-1",
    scope: "ourself:device:read ourself:repo:status", exp: Math.floor(Date.now() / 1000) + 300
  }, seatKeys.privateKey);
  const portalToken = signJwt({
    iss: "https://portal.example/admission", aud: "ourtunnelself", sub: "portal-decision-1",
    jti: "decision-1", caller_sub: "operator-1", target_device: deviceId,
    decision: "ADMIT", admitted_capabilities: ["repo.status"],
    authority_grant_ref: "grant-1", policy_version: "portal-v1",
    exp: Math.floor(Date.now() / 1000) + 120
  }, portalKeys.privateKey);

  const denied = await fetch(base + "/v1/seat/requests", {
    method: "POST", headers: { authorization: "Bearer " + seatToken, "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, capability: "repo.status", operation: "git_status", purpose: "test without admission" })
  });
  assert.equal(denied.status, 403);

  const created = await fetch(base + "/v1/seat/requests", {
    method: "POST", headers: { authorization: "Bearer " + seatToken, "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, capability: "repo.status", operation: "git_status", purpose: "governed test", target: ".", portal_admission: portalToken })
  });
  assert.equal(created.status, 202);
  const { job_id: jobId } = await created.json();
  const idempotentRetry = await fetch(base + "/v1/seat/requests", {
    method: "POST", headers: { authorization: "Bearer " + seatToken, "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, capability: "repo.status", operation: "git_status", purpose: "governed test", target: ".", portal_admission: portalToken })
  });
  const retryBody = await idempotentRetry.json();
  assert.equal(idempotentRetry.status, 202);
  assert.equal(retryBody.job_id, jobId);
  assert.equal(retryBody.idempotent_replay, true);

  const reusedAdmission = await fetch(base + "/v1/seat/requests", {
    method: "POST", headers: { authorization: "Bearer " + seatToken, "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, capability: "repo.status", operation: "git_status", purpose: "reuse decision", target: ".", portal_admission: portalToken })
  });
  assert.equal(reusedAdmission.status, 403);

  const pollHeaders = deviceHeaders("", deviceId, deviceKeys.privateKey);
  const delivered = await fetch(base + "/v1/device/poll", { method: "POST", headers: pollHeaders });
  assert.equal(delivered.status, 200);
  const envelope = await delivered.json();
  assert.equal(envelope.payload.job_id, jobId);
  assert.equal(envelope.payload.portal_admission, portalToken);
  const signedBody = Buffer.from(JSON.stringify(envelope.payload)).toString("base64url");
  assert.equal(crypto.verify("RSA-SHA256", Buffer.from(signedBody), brokerKeys.publicKey, Buffer.from(envelope.signature, "base64url")), true);

  await app.stop();
  const restarted = createOURTUNNELSELFServer({
    dataDir: path.join(root, "data"), deviceRegistryPath: registry,
    brokerPrivateKeyPath: brokerPrivate, seatPublicKeyPath: seatPublic, portalPublicKeyPath: portalPublic,
    seatIssuer: "https://osos.example/seat", seatAudience: "ourtunnelself",
    portalIssuer: "https://portal.example/admission", portalAudience: "ourtunnelself",
    host: "127.0.0.1", port: 0
  });
  await restarted.start();
  t.after(() => restarted.stop());
  const restartedBase = "http://127.0.0.1:" + restarted.server.address().port;
  const status = await fetch(restartedBase + "/v1/seat/requests/" + jobId, { headers: { authorization: "Bearer " + seatToken } });
  assert.equal((await status.json()).status, "DELIVERY_UNKNOWN");
  const replayedNonce = await fetch(restartedBase + "/v1/device/poll", { method: "POST", headers: pollHeaders });
  assert.equal(replayedNonce.status, 403);
  const noReplay = await fetch(restartedBase + "/v1/device/poll", {
    method: "POST", headers: deviceHeaders("", deviceId, deviceKeys.privateKey)
  });
  assert.equal(noReplay.status, 204);
});
