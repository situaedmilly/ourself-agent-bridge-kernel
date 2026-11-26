import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OURHOSTSELFState } from "../src/state.js";

function openState(file) {
  const db = new DatabaseSync(file);
  const sql = {
    exec(statement, ...params) {
      if (params.length === 0 && statement.includes(";")) {
        db.exec(statement);
        return { toArray: () => [] };
      }
      const query = db.prepare(statement);
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(statement)) return { toArray: () => query.all(...params) };
      query.run(...params);
      return { toArray: () => [] };
    }
  };
  const ctx = { storage: {
    sql,
    transactionSync(callback) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = callback(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  } };
  return { state: new OURHOSTSELFState(ctx), close: () => db.close() };
}
async function call(state, method, path, body) {
  const response = await state.fetch(new Request("https://state.internal" + path, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }));
  return { status: response.status, body: response.status === 204 ? null : await response.json() };
}

test("SQLite state enforces enrollment, nonce replay, delivery, evidence, revocation, and restart persistence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ourhostself-state-"));
  const file = join(dir, "state.sqlite");
  const deviceId = "sqlite-device-001";
  const portalAdmission = "staging-portal-admission-placeholder";
  const job = {
    job_id: "sqlite-job-001", device_id: deviceId, caller_sub: "seat-probe",
    capability: "repo.status", operation: "git_status", target: ".", purpose: "SQLite lifecycle test",
    portal_decision_jti: "portal-job-jti-001", portal_admission: portalAdmission,
    authority_grant_ref: "STAGING-PROBE-ONLY", policy_version: "state-test-v1",
    expires_at: Math.floor(Date.now() / 1000) + 300, created_at: new Date().toISOString()
  };
  try {
    let { state, close } = openState(file);
    const firstInstanceBootId = state.instanceBootId;
    let r = await call(state, "POST", "/selftest/write", {
      probe_id: "sqlite_restart_probe_001", payload: "persist-through-close-reopen",
      payload_digest: "a".repeat(64)
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.instance_boot_id, firstInstanceBootId);
    let persistedProbe = await call(state, "GET", "/selftest/read/sqlite_restart_probe_001");
    assert.equal(persistedProbe.status, 200);
    assert.equal(persistedProbe.body.record.payload, "persist-through-close-reopen");
    let r2 = await call(state, "GET", "/devices");
    r = r2;
    assert.equal(r.status, 200); assert.deepEqual(r.body.devices, []);

    r = await call(state, "POST", "/devices", {
      device_id: deviceId, label: "SQLite state probe",
      public_key_pem: "-----BEGIN PUBLIC KEY-----\nU1FMSVRFLVBSb2JlLU9ubHk=\n-----END PUBLIC KEY-----",
      portal_decision_jti: "portal-enroll-jti-001",
      authority_grant_ref: "STAGING-PROBE-ONLY", policy_version: "state-test-v1"
    });
    assert.equal(r.status, 201);
    r = await call(state, "GET", "/devices");
    assert.equal(r.body.devices[0].enabled, 1);

    r = await call(state, "POST", "/nonces", { device_id: deviceId, nonce: "a".repeat(24), expires_at_ms: Date.now() + 60000 });
    assert.equal(r.status, 200);
    r = await call(state, "POST", "/nonces", { device_id: deviceId, nonce: "a".repeat(24), expires_at_ms: Date.now() + 60000 });
    assert.equal(r.status, 409); assert.equal(r.body.error, "DEVICE_NONCE_REPLAY");

    r = await call(state, "POST", "/requests", job);
    assert.equal(r.status, 202);
    const replayJob = { ...job, job_id: "sqlite-job-replay", created_at: new Date().toISOString() };
    r = await call(state, "POST", "/requests", replayJob);
    assert.equal(r.status, 409);
    r = await call(state, "GET", "/devices/" + deviceId + "/next");
    assert.equal(r.status, 200); assert.equal(r.body.portal_admission, portalAdmission);
    r = await call(state, "POST", "/devices/" + deviceId + "/claim", {
      job_id: job.job_id, envelope: { payload_digest: "a".repeat(64) }
    });
    assert.equal(r.status, 200);
    r = await call(state, "GET", "/devices/" + deviceId + "/result-context?job_id=" + job.job_id + "&result_digest=" + "b".repeat(64));
    assert.equal(r.status, 200); assert.equal(r.body.status, "DELIVERY_UNKNOWN");

    const result = { job_id: job.job_id, state: "EXECUTED", local_receipt: { receipt_id: "local-receipt-001" } };
    const receipt = {
      receipt_id: "witness-receipt-001", signature: "signature-placeholder",
      payload: {
        job_id: job.job_id, device_id: deviceId, result_digest: "b".repeat(64),
        authority_grant_ref: job.authority_grant_ref, policy_version: job.policy_version,
        portal_decision_jti: job.portal_decision_jti
      }
    };
    r = await call(state, "POST", "/devices/" + deviceId + "/result", {
      result, result_digest: "b".repeat(64), device_timestamp: Math.floor(Date.now() / 1000),
      device_nonce: "a".repeat(24), device_signature: "device-signature-placeholder",
      evidence_receipt: receipt
    });
    assert.equal(r.status, 200); assert.equal(r.body.accepted, true);

    r = await call(state, "GET", "/requests/" + job.job_id + "?caller=seat-probe");
    assert.equal(r.status, 200); assert.equal(r.body.status, "COMPLETED");
    assert.equal(r.body.evidence_receipt.receipt_id, receipt.receipt_id);

    r = await call(state, "GET", "/devices/" + deviceId + "/result-context?job_id=" + job.job_id + "&result_digest=" + "b".repeat(64));
    assert.equal(r.status, 200); assert.equal(r.body.status, "COMPLETED");
    assert.equal(r.body.evidence_receipt.receipt_id, receipt.receipt_id);

    r = await call(state, "POST", "/devices/" + deviceId + "/revoke", {
      portal_decision_jti: "portal-revoke-jti-001",
      authority_grant_ref: "STAGING-PROBE-ONLY", policy_version: "state-test-v1"
    });
    assert.equal(r.status, 200);
    close();

    ({ state, close } = openState(file));
    assert.notEqual(state.instanceBootId, firstInstanceBootId, "a new Durable Object instance must have a new in-memory boot identity");
    persistedProbe = await call(state, "GET", "/selftest/read/sqlite_restart_probe_001");
    assert.equal(persistedProbe.status, 200);
    assert.equal(persistedProbe.body.record.payload, "persist-through-close-reopen");
    assert.notEqual(persistedProbe.body.instance_boot_id, firstInstanceBootId);
    r = await call(state, "GET", "/devices");
    assert.equal(r.status, 200); assert.equal(r.body.devices[0].enabled, 0);
    assert.ok(r.body.devices[0].revoked_at);
    r = await call(state, "GET", "/requests/" + job.job_id + "?caller=seat-probe");
    assert.equal(r.status, 200); assert.equal(r.body.status, "COMPLETED");
    assert.equal(r.body.evidence_receipt.receipt_id, receipt.receipt_id);
    close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
