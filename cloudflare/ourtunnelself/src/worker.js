const enc = new TextEncoder();
const json = (v, status = 200) => new Response(JSON.stringify(v), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
const decode = (s) => {
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};
const pem = (s) => Uint8Array.from(atob(s.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
const now = () => Math.floor(Date.now() / 1000);

async function verifyJwt(token, publicPem, expected) {
  const p = String(token || "").split(".");
  if (p.length !== 3) throw new Error("JWT_MALFORMED");
  const h = JSON.parse(new TextDecoder().decode(decode(p[0])));
  const c = JSON.parse(new TextDecoder().decode(decode(p[1])));
  if (h.alg !== "RS256" || h.typ !== "JWT") throw new Error("JWT_ALGORITHM_REJECTED");
  const key = await crypto.subtle.importKey("spki", pem(publicPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decode(p[2]), enc.encode(p[0] + "." + p[1]))) throw new Error("JWT_SIGNATURE_INVALID");
  if (!Number.isInteger(c.exp) || c.exp <= now()) throw new Error("JWT_EXPIRED");
  if (c.nbf && c.nbf > now()) throw new Error("JWT_NOT_YET_VALID");
  if (expected.iss && c.iss !== expected.iss) throw new Error("JWT_ISSUER_INVALID");
  if (expected.aud && !(c.aud === expected.aud || Array.isArray(c.aud) && c.aud.includes(expected.aud))) throw new Error("JWT_AUDIENCE_INVALID");
  return c;
}
async function seat(req, env, scope) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const c = await verifyJwt(token, env.OSOS_SEAT_PUBLIC_KEY_PEM, { iss: env.OURHOSTSELF_SEAT_ISSUER, aud: env.OURHOSTSELF_SEAT_AUDIENCE || "ourtunnelself" });
  if (!c.sub) throw new Error("JWT_SUBJECT_MISSING");
  const scopes = Array.isArray(c.scope) ? c.scope : String(c.scope || "").split(/\s+/);
  if (!scopes.includes(scope)) throw new Error("SEAT_SCOPE_DENIED");
  return c;
}
async function portal(token, caller, device, capability, env) {
  const c = await verifyJwt(token, env.OSOS_PORTAL_PUBLIC_KEY_PEM, { iss: env.OURHOSTSELF_PORTAL_ISSUER, aud: env.OURHOSTSELF_PORTAL_AUDIENCE || "ourtunnelself" });
  if (c.decision !== "ADMIT") throw new Error("PORTAL_NOT_ADMITTED");
  if (c.caller_sub !== caller.sub) throw new Error("PORTAL_CALLER_MISMATCH");
  if (c.target_device !== device) throw new Error("PORTAL_TARGET_MISMATCH");
  if (!Array.isArray(c.admitted_capabilities) || !c.admitted_capabilities.includes(capability)) throw new Error("PORTAL_CAPABILITY_MISMATCH");
  if (!c.authority_grant_ref || !c.policy_version || !c.jti) throw new Error("PORTAL_EVIDENCE_INCOMPLETE");
  return c;
}
const state = env => env.OURHOSTSELF_STATE.get(env.OURHOSTSELF_STATE.idFromName("global"));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({
      service: "OURHOSTSELF", state: "READY", authority: "NONE_BY_TRANSPORT", persistence: "DURABLE_OBJECT_SQLITE"
    });
    try {
      if (!env.OSOS_SEAT_PUBLIC_KEY_PEM || !env.OSOS_PORTAL_PUBLIC_KEY_PEM || !env.OURHOSTSELF_SEAT_ISSUER || !env.OURHOSTSELF_PORTAL_ISSUER) return json({ error: "TRUST_CONFIGURATION_REQUIRED" }, 503);
      if (request.method === "GET" && url.pathname === "/v1/seat/devices") {
        await seat(request, env, "ourself:device:read");
        return state(env).fetch("https://state.internal/devices");
      }
      if (request.method === "POST" && url.pathname === "/v1/seat/requests") {
        const caller = await seat(request, env, "ourself:repo:status");
        const body = await request.json();
        if (body.capability !== "repo.status" || body.operation !== "git_status") throw new Error("CAPABILITY_NOT_IMPLEMENTED");
        if (body.target !== undefined && body.target !== ".") throw new Error("TARGET_NOT_ADMITTED");
        if (typeof body.device_id !== "string" || typeof body.purpose !== "string" || !body.purpose.trim()) throw new Error("REQUEST_FIELDS_INVALID");
        const p = await portal(body.portal_admission, caller, body.device_id, body.capability, env);
        const job = {
          job_id: crypto.randomUUID(), device_id: body.device_id, caller_sub: caller.sub,
          capability: body.capability, operation: body.operation, target: body.target || ".",
          purpose: body.purpose.slice(0, 512), portal_decision_jti: p.jti,
          authority_grant_ref: p.authority_grant_ref, policy_version: p.policy_version,
          expires_at: Math.min(p.exp, now() + 120), created_at: new Date().toISOString()
        };
        return state(env).fetch("https://state.internal/requests", { method: "POST", body: JSON.stringify(job) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/seat/requests/")) {
        const caller = await seat(request, env, "ourself:repo:status");
        const id = encodeURIComponent(url.pathname.split("/").pop());
        return state(env).fetch("https://state.internal/requests/" + id + "?caller=" + encodeURIComponent(caller.sub));
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      const status = /JWT_|SIGNATURE|SCOPE|PORTAL_|CAPABILITY_|TARGET_|REQUEST_FIELDS/.test(e.message) ? 403 : 400;
      return json({ error: e.message || "REQUEST_REJECTED" }, status);
    }
  }
};
export { OURHOSTSELFState } from "./state.js";
