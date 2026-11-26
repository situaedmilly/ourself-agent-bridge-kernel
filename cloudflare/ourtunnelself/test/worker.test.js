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
  assert.equal(body.trust_configuration, "MISSING");
  assert.equal(body.delivery_signing_key, "MISSING");
  assert.equal(body.trust_chain_validation, "NOT_IMPLEMENTED");
  assert.equal(body.delivery_key_certification, "NOT_IMPLEMENTED");
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
  assert.equal(body.trust_configuration, "PRESENT_UNVERIFIED");
  assert.equal(body.trust_chain_validation, "NOT_IMPLEMENTED");
  assert.equal(JSON.stringify(body).includes("Zm9v"), false);
});

test("syntactically configured trust cannot bypass OSOS chain verification", async () => {
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
  assert.deepEqual(await response.json(), {
    error: "OSOS_TRUST_CHAIN_UNVERIFIED",
    configuration_state: "PRESENT_UNVERIFIED",
    trust_chain_validation: "NOT_IMPLEMENTED"
  });
});

test("staging SQLite probe is hidden without a token and uses the bound Durable Object when authorized", async () => {
  const hidden = await worker.fetch(new Request("https://unit.test/__staging/state-self-check", { method: "POST", body: JSON.stringify({ action: "read", probe_id: "probe_id_12345678" }) }), {});
  assert.equal(hidden.status, 404);

  const calls = [];
  const env = {
    OURHOSTSELF_STATESELF_PROBE_TOKEN: "probe-secret-token",
    OURHOSTSELF_STATE: {
      idFromName(name) { assert.equal(name, "global"); return "global-id"; },
      get(id) {
        assert.equal(id, "global-id");
        return { fetch: async (input, init = {}) => {
          calls.push({ url: String(input), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
          return new Response(JSON.stringify({ written: true, probe_id: "probe_id_12345678" }), { status: 200 });
        } };
      }
    }
  };
  const response = await worker.fetch(new Request("https://unit.test/__staging/state-self-check", {
    method: "POST", headers: { "content-type": "application/json", "x-ourhostself-state-probe": "probe-secret-token" },
    body: JSON.stringify({ action: "write", probe_id: "probe_id_12345678", payload: "sqlite-probe-payload" })
  }), env);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /selftest\/write$/);
  assert.equal(calls[0].body.payload, "sqlite-probe-payload");
  assert.match(calls[0].body.payload_digest, /^[a-f0-9]{64}$/);
});
