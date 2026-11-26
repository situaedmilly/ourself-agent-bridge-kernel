import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

test("health reports transport only, never authority", async () => {
  const response = await worker.fetch(new Request("https://unit.test/health"), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.service, "OURHOSTSELF");
  assert.equal(body.authority, "NONE_BY_TRANSPORT");
  assert.equal(body.persistence, "DURABLE_OBJECT_SQLITE");
  assert.equal(body.trust_configuration, "INVALID");
  assert.equal(body.delivery_signing_key, "MISSING");
  assert.equal(body.authority, "NONE_BY_TRANSPORT");
});

test("trust-dependent routes fail closed without issuer/key configuration", async () => {
  const response = await worker.fetch(new Request("https://unit.test/v1/seat/devices"), {});
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "TRUST_CONFIGURATION_REQUIRED");
  assert.deepEqual(body.missing, ["seat.public_key_pem", "seat.issuer", "portal.public_key_pem", "portal.issuer"]);
  assert.deepEqual(body.invalid, []);
  assert.equal(body.source, "LEGACY_WRANGLER_BINDINGS");
});

test("unmapped paths return 404 without requiring trust configuration", async () => {
  const response = await worker.fetch(new Request("https://unit.test/unknown"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
});

test("canonical trust secret is visible as readiness only", async () => {
  const key = "-----BEGIN PUBLIC KEY-----\\nZm9v\\n-----END PUBLIC KEY-----";
  const config = {
    schema: "TRUST_CONFIGURATION_OURSELFECOSYSTEM/v1",
    seat: { public_key_pem: key, issuer: "seat-issuer", audience: "ourtunnelself" },
    portal: { public_key_pem: key, issuer: "portal-issuer", audience: "ourtunnelself" }
  };
  const response = await worker.fetch(new Request("https://unit.test/health"), {
    TRUST_CONFIGURATION_OURSELFECOSYSTEM: JSON.stringify(config)
  });
  const body = await response.json();
  assert.equal(body.trust_configuration, "READY");
  assert.equal(JSON.stringify(body).includes("Zm9v"), false);
});

test("device transport fails closed until delivery signer is configured", async () => {
  const key = "-----BEGIN PUBLIC KEY-----\\nZm9v\\n-----END PUBLIC KEY-----";
  const config = {
    schema: "TRUST_CONFIGURATION_OURSELFECOSYSTEM/v1",
    seat: { public_key_pem: key, issuer: "seat-issuer", audience: "ourtunnelself" },
    portal: { public_key_pem: key, issuer: "portal-issuer", audience: "ourtunnelself" }
  };
  const response = await worker.fetch(new Request("https://unit.test/v1/device/poll", { method: "POST" }), {
    TRUST_CONFIGURATION_OURSELFECOSYSTEM: JSON.stringify(config)
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "DELIVERY_SIGNING_KEY_REQUIRED" });
});
