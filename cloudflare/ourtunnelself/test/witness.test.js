import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalJson, signDeliveryEnvelope, verifyDeviceRequest } from "../src/witness.js";

const DOMAIN = Buffer.from("OURSELF-PIPE-PORTAL-COMMAND-JCS-RFC8785-V1\0", "utf8");

test("delivery envelope is canonical, domain-separated, and Ed25519 signed", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const payload = { z: 1, a: { y: true, b: "value" } };
  const envelope = await signDeliveryEnvelope(payload, privatePem);
  const body = Buffer.from(canonicalJson(payload));
  const signed = Buffer.concat([DOMAIN, body]);
  assert.equal(envelope.payload_encoding, "OURSELF-JCS-RFC8785-V1");
  assert.equal(envelope.payload_byte_length, body.length);
  assert.equal(envelope.payload_digest, crypto.createHash("sha256").update(signed).digest("hex"));
  assert.equal(crypto.verify(null, signed, pair.publicKey, Buffer.from(envelope.signature, "base64url")), true);
});

test("device request signature binds timestamp, nonce, and exact body digest", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = '{"job_id":"job-1","state":"EXECUTED"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(24).toString("base64url");
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const message = [timestamp, nonce, digest].join(".");
  const signature = crypto.sign(null, Buffer.from(message), pair.privateKey).toString("base64url");
  const verified = await verifyDeviceRequest({ timestamp, nonce, body, signature, publicPem });
  assert.equal(verified.body_digest, digest);
  assert.equal(verified.nonce, nonce);
});

test("device request rejects stale timestamps and malformed nonces", async () => {
  const pair = crypto.generateKeyPairSync("ed25519");
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const stale = String(Math.floor(Date.now() / 1000) - 120);
  await assert.rejects(() => verifyDeviceRequest({ timestamp: stale, nonce: "a".repeat(24), body: "", signature: "a".repeat(86), publicPem }), /DEVICE_TIMESTAMP_INVALID/);
  await assert.rejects(() => verifyDeviceRequest({ timestamp: String(Math.floor(Date.now() / 1000)), nonce: "bad", body: "", signature: "a".repeat(86), publicPem }), /DEVICE_NONCE_INVALID/);
});

test("canonical witness serializer rejects unpaired surrogate values", () => {
  assert.throws(() => canonicalJson({ value: "\uD800" }), /WITNESS_UNICODE_INVALID/);
});
