import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrustConfiguration, TRUST_CONFIGURATION_SCHEMA } from "../src/trust-config.js";
const key = "-----BEGIN PUBLIC KEY-----\\nZm9v\\n-----END PUBLIC KEY-----";
const canonical = {
  schema: TRUST_CONFIGURATION_SCHEMA,
  seat: { public_key_pem: key, issuer: "https://osos.staging.invalid", audience: "ourtunnelself" },
  portal: { public_key_pem: key, issuer: "https://portal.staging.invalid", audience: "ourtunnelself" }
};
test("canonical OURSELF ecosystem trust config resolves", () => {
  const r = resolveTrustConfiguration({ TRUST_CONFIGURATION_OURSELFECOSYSTEM: JSON.stringify(canonical) });
  assert.equal(r.state, "PRESENT_UNVERIFIED"); assert.equal(r.source, "TRUST_CONFIGURATION_OURSELFECOSYSTEM");
  assert.deepEqual(r.missing, []); assert.deepEqual(r.invalid, []); assert.equal(r.trust_chain_validation, "NOT_IMPLEMENTED");
});
test("missing trust fields are enumerated", () => {
  const r = resolveTrustConfiguration({});
  assert.equal(r.state, "MISSING"); assert.equal(r.source, "LEGACY_WRANGLER_BINDINGS");
  assert.deepEqual(r.missing, ["seat.public_key_pem","seat.issuer","portal.public_key_pem","portal.issuer"]);
});
test("malformed JSON and schema fail closed", () => {
  assert.deepEqual(resolveTrustConfiguration({ TRUST_CONFIGURATION_OURSELFECOSYSTEM: "{" }).invalid, ["TRUST_CONFIGURATION_OURSELFECOSYSTEM_JSON"]);
  assert.deepEqual(resolveTrustConfiguration({ TRUST_CONFIGURATION_OURSELFECOSYSTEM: JSON.stringify({ ...canonical, schema: "wrong" }) }).invalid, ["schema"]);
});
test("legacy bindings remain supported during migration", () => {
  const r = resolveTrustConfiguration({ OSOS_SEAT_PUBLIC_KEY_PEM:key, OURHOSTSELF_SEAT_ISSUER:"seat", OSOS_PORTAL_PUBLIC_KEY_PEM:key, OURHOSTSELF_PORTAL_ISSUER:"portal" });
  assert.equal(r.state, "PRESENT_UNVERIFIED"); assert.equal(r.source, "LEGACY_WRANGLER_BINDINGS");
});
test("malformed key diagnostics never echo key material", () => {
  const bad = "not-a-pem";
  const r = resolveTrustConfiguration({ TRUST_CONFIGURATION_OURSELFECOSYSTEM: JSON.stringify({ ...canonical, seat: { ...canonical.seat, public_key_pem: bad } }) });
  assert.deepEqual(r.invalid, ["seat.public_key_pem"]); assert.equal(JSON.stringify(r).includes(bad), false);
});
