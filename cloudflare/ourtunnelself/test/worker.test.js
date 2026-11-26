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
});

test("trust-dependent routes fail closed without issuer/key configuration", async () => {
  const response = await worker.fetch(new Request("https://unit.test/v1/seat/devices"), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "TRUST_CONFIGURATION_REQUIRED" });
});

test("unmapped paths do not expose implementation details", async () => {
  const response = await worker.fetch(new Request("https://unit.test/unknown"), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "TRUST_CONFIGURATION_REQUIRED" });
});
