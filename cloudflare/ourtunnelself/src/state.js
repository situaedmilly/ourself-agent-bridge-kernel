const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export class OURHOSTSELFState {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
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
    if (request.method === "GET" && url.pathname === "/devices") {
      const devices = this.sql.exec("SELECT device_id,label,enabled,revoked_at FROM devices ORDER BY device_id").toArray();
      return json({ devices });
    }
    if (request.method === "POST" && url.pathname === "/requests") {
      const job = await request.json();
      if (!job.portal_decision_jti || !job.authority_grant_ref || !job.policy_version) return json({ error: "PORTAL_EVIDENCE_INCOMPLETE" }, 400);
      try {
        this.ctx.storage.transactionSync(() => {
          const prior = this.sql.exec("SELECT job_id FROM jobs WHERE portal_decision_jti = ?", job.portal_decision_jti).toArray()[0];
          if (prior) throw new Error("PORTAL_REPLAY_REJECTED");
          const device = this.sql.exec("SELECT device_id FROM devices WHERE device_id = ? AND enabled = 1 AND revoked_at IS NULL", job.device_id).toArray()[0];
          if (!device) throw new Error("DEVICE_NOT_ADMITTED");
          this.sql.exec(
            "INSERT INTO jobs (job_id,device_id,caller_sub,capability,operation,target,purpose,portal_decision_jti,authority_grant_ref,policy_version,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            job.job_id, job.device_id, job.caller_sub, job.capability, job.operation, job.target, job.purpose,
            job.portal_decision_jti, job.authority_grant_ref, job.policy_version, job.expires_at, "QUEUED", job.created_at
          );
          this.appendEvent("REQUESTED", job.job_id, job);
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
      return json({ job_id: job.job_id, status, result: job.result_json ? JSON.parse(job.result_json) : null });
    }
    return json({ error: "NOT_FOUND" }, 404);
  }
}
