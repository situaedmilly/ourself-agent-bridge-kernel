const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export class OURHOSTSELFState {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.instanceBootId = crypto.randomUUID();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY, label TEXT NOT NULL, public_key_pem TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL, aggregate_id TEXT, payload_json TEXT NOT NULL, recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, caller_sub TEXT NOT NULL,
        capability TEXT NOT NULL, operation TEXT NOT NULL, target TEXT NOT NULL, purpose TEXT NOT NULL,
        portal_decision_jti TEXT NOT NULL UNIQUE, authority_grant_ref TEXT NOT NULL,
        policy_version TEXT NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL,
        result_json TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_nonces (
        replay_key TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_portal_decisions (
        decision_jti TEXT PRIMARY KEY, decision_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_secrets (job_id TEXT PRIMARY KEY, portal_admission TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_receipts (
        receipt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, device_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL, recorded_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_result_digests (job_id TEXT PRIMARY KEY, result_digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_self_probe (
        probe_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_digest TEXT NOT NULL,
        written_at TEXT NOT NULL
      );
    `);
  }

  appendEvent(type, aggregateId, payload) {
    this.sql.exec(
      "INSERT INTO events (event_id,event_type,aggregate_id,payload_json,recorded_at) VALUES (?,?,?,?,?)",
      crypto.randomUUID(), type, aggregateId || null, JSON.stringify(payload), new Date().toISOString()
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/selftest/write") {
      const body = await request.json();
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(body.probe_id || "") || typeof body.payload !== "string" || body.payload.length > 2048 || !/^[a-f0-9]{64}$/.test(body.payload_digest || "")) {
        return json({ error: "STATE_PROBE_FIELDS_INVALID" }, 400);
      }
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(
          "INSERT INTO state_self_probe (probe_id,payload,payload_digest,written_at) VALUES (?,?,?,?) ON CONFLICT(probe_id) DO UPDATE SET payload=excluded.payload,payload_digest=excluded.payload_digest,written_at=excluded.written_at",
          body.probe_id, body.payload, body.payload_digest, new Date().toISOString()
        );
      });
      return json({ written: true, probe_id: body.probe_id, instance_boot_id: this.instanceBootId });
    }
    if (request.method === "GET" && url.pathname.startsWith("/selftest/read/")) {
      const probeId = decodeURIComponent(url.pathname.split("/").pop() || "");
      const record = this.sql.exec("SELECT probe_id,payload,payload_digest,written_at FROM state_self_probe WHERE probe_id = ?", probeId).toArray()[0];
      return record ? json({ found: true, record, instance_boot_id: this.instanceBootId }) : json({ found: false, instance_boot_id: this.instanceBootId }, 404);
    }
    if (request.method === "GET" && url.pathname === "/devices") {
      const devices = this.sql.exec("SELECT device_id,label,enabled,revoked_at FROM devices ORDER BY device_id").toArray();
      return json({ devices });
    }
    if (request.method === "GET" && url.pathname.startsWith("/devices/") && url.pathname.endsWith("/credential")) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
      const device = this.sql.exec("SELECT device_id,public_key_pem FROM devices WHERE device_id = ? AND enabled = 1 AND revoked_at IS NULL", deviceId).toArray()[0];
      return device ? json(device) : json({ error: "DEVICE_NOT_ADMITTED" }, 403);
    }
    if (request.method === "POST" && url.pathname === "/nonces") {
      const body = await request.json();
      if (!body.device_id || !/^[A-Za-z0-9_-]{20,128}$/.test(body.nonce || "") || !Number.isSafeInteger(body.expires_at_ms)) return json({ error: "DEVICE_NONCE_FIELDS_INVALID" }, 400);
      try {
        this.ctx.storage.transactionSync(() => {
          const device = this.sql.exec("SELECT device_id FROM devices WHERE device_id = ? AND enabled = 1 AND revoked_at IS NULL", body.device_id).toArray()[0];
          if (!device) throw new Error("DEVICE_NOT_ADMITTED");
          this.sql.exec("DELETE FROM consumed_nonces WHERE expires_at_ms <= ?", Date.now());
          this.sql.exec("INSERT INTO consumed_nonces (replay_key,expires_at_ms) VALUES (?,?)", body.device_id + ":" + body.nonce, body.expires_at_ms);
        });
      } catch (e) {
        return json({ error: e.message === "DEVICE_NOT_ADMITTED" ? e.message : "DEVICE_NONCE_REPLAY" }, e.message === "DEVICE_NOT_ADMITTED" ? 403 : 409);
      }
      return json({ accepted: true });
    }
    if (request.method === "GET" && url.pathname.startsWith("/devices/") && url.pathname.endsWith("/next")) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
      const job = this.sql.exec("SELECT * FROM jobs WHERE device_id = ? AND status = 'QUEUED' AND expires_at > ? ORDER BY created_at LIMIT 1", deviceId, Math.floor(Date.now() / 1000)).toArray()[0];
      if (!job) return new Response(null, { status: 204 });
      const secret = this.sql.exec("SELECT portal_admission FROM job_secrets WHERE job_id = ?", job.job_id).toArray()[0];
      if (!secret) return json({ error: "JOB_DELIVERY_EVIDENCE_MISSING" }, 409);
      return json({ job, portal_admission: secret.portal_admission });
    }
    if (request.method === "POST" && url.pathname.startsWith("/devices/") && url.pathname.endsWith("/claim")) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
      const body = await request.json();
      try {
        this.ctx.storage.transactionSync(() => {
          const job = this.sql.exec("SELECT job_id,status FROM jobs WHERE job_id = ? AND device_id = ?", body.job_id, deviceId).toArray()[0];
          if (!job || job.status !== "QUEUED") throw new Error("JOB_NOT_QUEUED");
          this.sql.exec("UPDATE jobs SET status = 'DELIVERY_UNKNOWN' WHERE job_id = ?", body.job_id);
          this.appendEvent("DELIVERED", body.job_id, { device_id: deviceId, envelope_digest: body.envelope?.payload_digest || null });
        });
      } catch (e) { return json({ error: e.message || "JOB_CLAIM_REJECTED" }, 409); }
      return json({ claimed: true, job_id: body.job_id });
    }
    if (request.method === "GET" && url.pathname.startsWith("/devices/") && url.pathname.endsWith("/result-context")) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
      const jobId = url.searchParams.get("job_id") || "";
      const job = this.sql.exec("SELECT job_id,authority_grant_ref,policy_version,portal_decision_jti,expires_at,status FROM jobs WHERE job_id = ? AND device_id = ?", jobId, deviceId).toArray()[0];
      if (!job) return json({ error: "JOB_STATE_INVALID" }, 409);
      if (job.status === "COMPLETED") {
        const digest = this.sql.exec("SELECT result_digest FROM job_result_digests WHERE job_id = ?", jobId).toArray()[0];
        const receipt = this.sql.exec("SELECT envelope_json FROM evidence_receipts WHERE job_id = ?", jobId).toArray()[0];
        if (!digest || digest.result_digest !== url.searchParams.get("result_digest") || !receipt) return json({ error: "JOB_RESULT_CONFLICT" }, 409);
        return json({ ...job, evidence_receipt: JSON.parse(receipt.envelope_json) });
      }
      if (job.status !== "DELIVERY_UNKNOWN" || job.expires_at <= Math.floor(Date.now() / 1000)) return json({ error: "JOB_STATE_INVALID" }, 409);
      return json(job);
    }
    if (request.method === "POST" && url.pathname.startsWith("/devices/") && url.pathname.endsWith("/result")) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
      const body = await request.json();
      const receipt = body.evidence_receipt;
      if (!body.result || !body.result_digest || !receipt?.receipt_id || !receipt?.signature || !receipt?.payload) return json({ error: "RESULT_EVIDENCE_INCOMPLETE" }, 400);
      try {
        this.ctx.storage.transactionSync(() => {
          const job = this.sql.exec("SELECT * FROM jobs WHERE job_id = ? AND device_id = ?", body.result.job_id, deviceId).toArray()[0];
          if (!job || job.status !== "DELIVERY_UNKNOWN" || job.expires_at <= Math.floor(Date.now() / 1000)) throw new Error("JOB_STATE_INVALID");
          if (receipt.payload.job_id !== job.job_id || receipt.payload.device_id !== deviceId ||
              receipt.payload.result_digest !== body.result_digest ||
              receipt.payload.authority_grant_ref !== job.authority_grant_ref ||
              receipt.payload.policy_version !== job.policy_version ||
              receipt.payload.portal_decision_jti !== job.portal_decision_jti) throw new Error("EVIDENCE_BINDING_INVALID");
          this.sql.exec("UPDATE jobs SET status = 'COMPLETED', result_json = ? WHERE job_id = ?", JSON.stringify(body.result), job.job_id);
          this.sql.exec("INSERT INTO job_result_digests (job_id,result_digest) VALUES (?,?)", job.job_id, body.result_digest);
          this.appendEvent("RESULT_RECEIVED", job.job_id, {
            device_id: deviceId, result_digest: body.result_digest,
            device_timestamp: body.device_timestamp, device_nonce: body.device_nonce,
            device_signature: body.device_signature
          });
          this.sql.exec("INSERT INTO evidence_receipts (receipt_id,job_id,device_id,envelope_json,recorded_at) VALUES (?,?,?,?,?)",
            receipt.receipt_id, job.job_id, deviceId, JSON.stringify(receipt), new Date().toISOString());
          this.appendEvent("DATASELF_EVIDENCE_RECEIPT", job.job_id, {
            receipt_id: receipt.receipt_id, device_id: deviceId,
            payload_digest: receipt.payload_digest, signature: receipt.signature
          });
          this.sql.exec("DELETE FROM job_secrets WHERE job_id = ?", job.job_id);
        });
      } catch (e) {
        return json({ error: e.message || "JOB_RESULT_REJECTED" }, 409);
      }
      return json({ accepted: true, job_id: body.result.job_id, evidence_receipt_id: receipt.receipt_id });
    }
    if (request.method === "POST" && url.pathname === "/devices") {
      const device = await request.json();
      if (!/^[A-Za-z0-9._:-]{3,128}$/.test(device.device_id || "") ||
          typeof device.label !== "string" || !device.label.trim() || device.label.length > 128 ||
          typeof device.public_key_pem !== "string" || device.public_key_pem.length > 4096 || !device.public_key_pem.includes("BEGIN PUBLIC KEY") ||
          !device.portal_decision_jti || !device.authority_grant_ref || !device.policy_version) {
        return json({ error: "DEVICE_ENROLLMENT_FIELDS_INVALID" }, 400);
      }
      try {
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            "INSERT INTO consumed_portal_decisions (decision_jti,decision_type,aggregate_id,consumed_at) VALUES (?,?,?,?)",
            device.portal_decision_jti, "DEVICE_ENROLL", device.device_id, new Date().toISOString()
          );
          this.sql.exec(
            "INSERT INTO devices (device_id,label,public_key_pem,enabled,revoked_at) VALUES (?,?,?,?,NULL)",
            device.device_id, device.label.trim(), device.public_key_pem, 1
          );
          this.appendEvent("DEVICE_ADMITTED", device.device_id, {
            device_id: device.device_id, label: device.label.trim(),
            authority_grant_ref: device.authority_grant_ref, policy_version: device.policy_version,
            portal_decision_jti: device.portal_decision_jti
          });
        });
      } catch (e) {
        return json({ error: e.message?.includes("UNIQUE") ? "DEVICE_OR_PORTAL_DECISION_REPLAY" : "DEVICE_ENROLLMENT_REJECTED" }, 409);
      }
      return json({ device_id: device.device_id, state: "ADMITTED", authority: "PORTAL_BOUNDED" }, 201);
    }
    if (request.method === "POST" && url.pathname.startsWith("/devices/") && url.pathname.endsWith("/revoke")) {
      const deviceId = decodeURIComponent(url.pathname.split("/")[2] || "");
      const revocation = await request.json();
      if (!deviceId || !revocation.portal_decision_jti || !revocation.authority_grant_ref || !revocation.policy_version) {
        return json({ error: "DEVICE_REVOCATION_FIELDS_INVALID" }, 400);
      }
      try {
        this.ctx.storage.transactionSync(() => {
          const existing = this.sql.exec("SELECT device_id FROM devices WHERE device_id = ?", deviceId).toArray()[0];
          if (!existing) throw new Error("DEVICE_NOT_FOUND");
          this.sql.exec(
            "INSERT INTO consumed_portal_decisions (decision_jti,decision_type,aggregate_id,consumed_at) VALUES (?,?,?,?)",
            revocation.portal_decision_jti, "DEVICE_REVOKE", deviceId, new Date().toISOString()
          );
          this.sql.exec("UPDATE devices SET enabled = 0, revoked_at = ? WHERE device_id = ?", new Date().toISOString(), deviceId);
          this.appendEvent("DEVICE_REVOKED", deviceId, {
            device_id: deviceId, authority_grant_ref: revocation.authority_grant_ref,
            policy_version: revocation.policy_version, portal_decision_jti: revocation.portal_decision_jti
          });
        });
      } catch (e) {
        return json({ error: e.message === "DEVICE_NOT_FOUND" ? "DEVICE_NOT_FOUND" : e.message?.includes("UNIQUE") ? "PORTAL_DECISION_REPLAY" : "DEVICE_REVOCATION_REJECTED" }, e.message === "DEVICE_NOT_FOUND" ? 404 : 409);
      }
      return json({ device_id: deviceId, state: "REVOKED" });
    }
    if (request.method === "POST" && url.pathname === "/requests") {
      const job = await request.json();
      if (!job.portal_decision_jti || !job.authority_grant_ref || !job.policy_version) return json({ error: "PORTAL_EVIDENCE_INCOMPLETE" }, 400);
      try {
        this.ctx.storage.transactionSync(() => {
          const prior = this.sql.exec("SELECT job_id FROM jobs WHERE portal_decision_jti = ?", job.portal_decision_jti).toArray()[0];
          if (prior) throw new Error("PORTAL_REPLAY_REJECTED");
          this.sql.exec(
            "INSERT INTO consumed_portal_decisions (decision_jti,decision_type,aggregate_id,consumed_at) VALUES (?,?,?,?)",
            job.portal_decision_jti, "JOB_REQUEST", job.job_id, new Date().toISOString()
          );
          const device = this.sql.exec("SELECT device_id FROM devices WHERE device_id = ? AND enabled = 1 AND revoked_at IS NULL", job.device_id).toArray()[0];
          if (!device) throw new Error("DEVICE_NOT_ADMITTED");
          this.sql.exec(
            "INSERT INTO jobs (job_id,device_id,caller_sub,capability,operation,target,purpose,portal_decision_jti,authority_grant_ref,policy_version,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            job.job_id, job.device_id, job.caller_sub, job.capability, job.operation, job.target, job.purpose,
            job.portal_decision_jti, job.authority_grant_ref, job.policy_version, job.expires_at, "QUEUED", job.created_at
          );
          this.sql.exec("INSERT INTO job_secrets (job_id,portal_admission) VALUES (?,?)", job.job_id, job.portal_admission);
          const { portal_admission, ...eventJob } = job;
          this.appendEvent("REQUESTED", job.job_id, eventJob);
        });
      } catch (e) {
        const status = e.message === "DEVICE_NOT_ADMITTED" ? 403 : 409;
        return json({ error: e.message || "STATE_WRITE_REJECTED" }, status);
      }
      return json({ job_id: job.job_id, status: "QUEUED", expires_at: job.expires_at }, 202);
    }
    if (request.method === "GET" && url.pathname.startsWith("/requests/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const caller = url.searchParams.get("caller");
      const job = this.sql.exec(
        "SELECT job_id,status,result_json,expires_at FROM jobs WHERE job_id = ? AND caller_sub = ?", id, caller
      ).toArray()[0];
      if (!job) return json({ error: "JOB_NOT_FOUND" }, 404);
      const status = job.status === "QUEUED" && job.expires_at <= Math.floor(Date.now() / 1000) ? "EXPIRED" : job.status;
      const receipt = this.sql.exec("SELECT envelope_json FROM evidence_receipts WHERE job_id = ?", id).toArray()[0];
      return json({ job_id: job.job_id, status, result: job.result_json ? JSON.parse(job.result_json) : null, evidence_receipt: receipt ? JSON.parse(receipt.envelope_json) : null });
    }
    return json({ error: "NOT_FOUND" }, 404);
  }
}
