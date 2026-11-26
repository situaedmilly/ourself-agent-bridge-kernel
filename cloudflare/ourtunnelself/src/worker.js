import { resolveTrustConfiguration } from "./trust-config.js";
import { signDeliveryEnvelope, verifyDeviceRequest, canonicalJson } from "./witness.js";

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
async function seat(req, trust, scope) {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const c = await verifyJwt(token, trust.seat.public_key_pem, { iss: trust.seat.issuer, aud: trust.seat.audience });
  if (!c.sub) throw new Error("JWT_SUBJECT_MISSING");
  const scopes = Array.isArray(c.scope) ? c.scope : String(c.scope || "").split(/\s+/);
  if (!scopes.includes(scope)) throw new Error("SEAT_SCOPE_DENIED");
  return c;
}
async function portal(token, caller, device, capability, trust) {
  const c = await verifyJwt(token, trust.portal.public_key_pem, { iss: trust.portal.issuer, aud: trust.portal.audience });
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
    if (request.method === "GET" && url.pathname === "/health") {
      const resolved = resolveTrustConfiguration(env);
      return json({
        service: "OURHOSTSELF", state: "READY", authority: "NONE_BY_TRANSPORT",
        persistence: "DURABLE_OBJECT_SQLITE", trust_configuration: resolved.state,
        trust_chain_validation: "NOT_IMPLEMENTED",
        delivery_signing_key: env.OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM ? "PRESENT_UNVERIFIED" : "MISSING",
        delivery_key_certification: "NOT_IMPLEMENTED",
        trust_configuration_source: resolved.source,
        ...(resolved.state === "READY" ? {} : { trust_configuration_missing: resolved.missing, trust_configuration_invalid: resolved.invalid })
      });
    }
    const supported = request.method === "GET" && (url.pathname === "/v1/seat/devices" || url.pathname.startsWith("/v1/seat/requests/")) ||
      request.method === "POST" && (url.pathname === "/v1/seat/requests" || url.pathname === "/v1/seat/devices/enroll" ||
        /^\/v1\/seat\/devices\/[^/]+\/revoke$/.test(url.pathname) ||
        url.pathname === "/v1/device/poll" || url.pathname === "/v1/device/result");
    if (!supported) return json({ error: "NOT_FOUND" }, 404);
    try {
      const resolved = resolveTrustConfiguration(env);
      if (resolved.state === "MISSING" || resolved.state === "INVALID") return json({
        error: "TRUST_CONFIGURATION_REQUIRED", missing: resolved.missing,
        invalid: resolved.invalid, source: resolved.source
      }, 503);
      // A syntactically valid secret is not an OSOS-certified trust chain. Keep all
      // authority-bearing routes blocked until the root/subordinate issuer profile
      // and key certification format are implemented and independently verified.
      if (resolved.state !== "VERIFIED") return json({
        error: "OSOS_TRUST_CHAIN_UNVERIFIED",
        configuration_state: resolved.state,
        trust_chain_validation: "NOT_IMPLEMENTED"
      }, 503);
      const trust = resolved.config;
      if (request.method === "GET" && url.pathname === "/v1/seat/devices") {
        await seat(request, trust, "ourself:device:read");
        return state(env).fetch("https://state.internal/devices");
      }
      if (request.method === "POST" && url.pathname === "/v1/seat/devices/enroll") {
        const caller = await seat(request, trust, "ourself:device:enroll");
        const body = await request.json();
        const p = await portal(body.portal_admission, caller, body.device_id, "device.enroll", trust);
        const keyBytes = pem(body.public_key_pem);
        await crypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
        return state(env).fetch("https://state.internal/devices", {
          method: "POST",
          body: JSON.stringify({
            device_id: body.device_id, label: body.label, public_key_pem: body.public_key_pem,
            portal_decision_jti: p.jti, authority_grant_ref: p.authority_grant_ref, policy_version: p.policy_version
          })
        });
      }
      const revokeMatch = url.pathname.match(/^\/v1\/seat\/devices\/([^/]+)\/revoke$/);
      if (request.method === "POST" && revokeMatch) {
        const caller = await seat(request, trust, "ourself:device:revoke");
        const body = await request.json();
        const deviceId = decodeURIComponent(revokeMatch[1]);
        const p = await portal(body.portal_admission, caller, deviceId, "device.revoke", trust);
        return state(env).fetch("https://state.internal/devices/" + encodeURIComponent(deviceId) + "/revoke", {
          method: "POST",
          body: JSON.stringify({ portal_decision_jti: p.jti, authority_grant_ref: p.authority_grant_ref, policy_version: p.policy_version })
        });
      }
      if (request.method === "POST" && (url.pathname === "/v1/device/poll" || url.pathname === "/v1/device/result")) {
        if (!env.OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM) return json({ error: "DELIVERY_SIGNING_KEY_REQUIRED" }, 503);
        const rawBody = await request.text();
        if (rawBody.length > 65536) return json({ error: "DEVICE_BODY_TOO_LARGE" }, 413);
        const deviceId = request.headers.get("x-ourself-device") || "";
        const timestamp = request.headers.get("x-ourself-timestamp") || "";
        const nonce = request.headers.get("x-ourself-nonce") || "";
        const signature = request.headers.get("x-ourself-signature") || "";
        const credentialResponse = await state(env).fetch("https://state.internal/devices/" + encodeURIComponent(deviceId) + "/credential");
        if (!credentialResponse.ok) return json({ error: "DEVICE_NOT_ADMITTED" }, 403);
        const credential = await credentialResponse.json();
        const verified = await verifyDeviceRequest({ timestamp, nonce, body: rawBody, signature, publicPem: credential.public_key_pem });
        const nonceResponse = await state(env).fetch("https://state.internal/nonces", {
          method: "POST", body: JSON.stringify({ device_id: deviceId, nonce, expires_at_ms: Date.now() + 120000 })
        });
        if (!nonceResponse.ok) return nonceResponse;
        if (url.pathname === "/v1/device/poll") {
          if (rawBody !== "") return json({ error: "DEVICE_POLL_BODY_INVALID" }, 400);
          const nextResponse = await state(env).fetch("https://state.internal/devices/" + encodeURIComponent(deviceId) + "/next");
          if (nextResponse.status === 204) return new Response(null, { status: 204 });
          if (!nextResponse.ok) return nextResponse;
          const next = await nextResponse.json();
          const payload = {
            job_id: next.job.job_id, device_id: deviceId, caller_sub: next.job.caller_sub,
            capability: next.job.capability, operation: next.job.operation, target: next.job.target,
            purpose: next.job.purpose, portal_admission: next.portal_admission,
            authority_grant_ref: next.job.authority_grant_ref, policy_version: next.job.policy_version,
            expires_at: next.job.expires_at
          };
          const envelope = await signDeliveryEnvelope(payload, env.OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM);
          const claim = await state(env).fetch("https://state.internal/devices/" + encodeURIComponent(deviceId) + "/claim", {
            method: "POST", body: JSON.stringify({ job_id: next.job.job_id, envelope })
          });
          if (!claim.ok) return claim;
          return json(envelope);
        }
        let result;
        try { result = JSON.parse(rawBody); } catch { return json({ error: "DEVICE_RESULT_JSON_INVALID" }, 400); }
        if (canonicalJson(result) !== rawBody) return json({ error: "DEVICE_RESULT_NOT_CANONICAL" }, 400);
        if (!result || typeof result.job_id !== "string") return json({ error: "DEVICE_RESULT_FIELDS_INVALID" }, 400);
        const contextResponse = await state(env).fetch("https://state.internal/devices/" + encodeURIComponent(deviceId) + "/result-context?job_id=" + encodeURIComponent(result.job_id) + "&result_digest=" + encodeURIComponent(verified.body_digest));
        if (!contextResponse.ok) return contextResponse;
        const context = await contextResponse.json();
        if (context.status === "COMPLETED" && context.evidence_receipt) {
          return json({ accepted: true, job_id: result.job_id, evidence_receipt: context.evidence_receipt, idempotent_replay: true });
        }
        const receipt = {
          receipt_id: crypto.randomUUID(), job_id: result.job_id, device_id: deviceId,
          result_digest: verified.body_digest, device_timestamp: verified.timestamp,
          device_nonce: verified.nonce, device_signature: signature,
          authority_grant_ref: context.authority_grant_ref, policy_version: context.policy_version,
          portal_decision_jti: context.portal_decision_jti, recorded_at: new Date().toISOString()
        };
        const signedReceipt = await signDeliveryEnvelope(receipt, env.OURHOSTSELF_DELIVERY_PRIVATE_KEY_PEM);
        const resultResponse = await state(env).fetch("https://state.internal/devices/" + encodeURIComponent(deviceId) + "/result", {
          method: "POST", body: JSON.stringify({
            result, device_signature: signature, device_timestamp: verified.timestamp,
            device_nonce: verified.nonce, result_digest: verified.body_digest,
            evidence_receipt: { ...signedReceipt, receipt_id: receipt.receipt_id }
          })
        });
        if (!resultResponse.ok) return resultResponse;
        return json({ accepted: true, job_id: result.job_id, evidence_receipt: signedReceipt });
      }
      if (request.method === "POST" && url.pathname === "/v1/seat/requests") {
        const caller = await seat(request, trust, "ourself:repo:status");
        const body = await request.json();
        if (body.capability !== "repo.status" || body.operation !== "git_status") throw new Error("CAPABILITY_NOT_IMPLEMENTED");
        if (body.target !== undefined && body.target !== ".") throw new Error("TARGET_NOT_ADMITTED");
        if (typeof body.device_id !== "string" || typeof body.purpose !== "string" || !body.purpose.trim()) throw new Error("REQUEST_FIELDS_INVALID");
        const p = await portal(body.portal_admission, caller, body.device_id, body.capability, trust);
        const job = {
          job_id: crypto.randomUUID(), device_id: body.device_id, caller_sub: caller.sub,
          capability: body.capability, operation: body.operation, target: body.target || ".",
          purpose: body.purpose.slice(0, 512), portal_decision_jti: p.jti,
          portal_admission: body.portal_admission,
          authority_grant_ref: p.authority_grant_ref, policy_version: p.policy_version,
          expires_at: Math.min(p.exp, now() + 120), created_at: new Date().toISOString()
        };
        return state(env).fetch("https://state.internal/requests", { method: "POST", body: JSON.stringify(job) });
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/seat/requests/")) {
        const caller = await seat(request, trust, "ourself:repo:status");
        const id = encodeURIComponent(url.pathname.split("/").pop());
        return state(env).fetch("https://state.internal/requests/" + id + "?caller=" + encodeURIComponent(caller.sub));
      }
      return json({ error: "NOT_FOUND" }, 404);
    } catch (e) {
      const status = /JWT_|SIGNATURE|SCOPE|PORTAL_|CAPABILITY_|TARGET_|REQUEST_FIELDS|DEVICE_/.test(e.message) ? 403 : 400;
      return json({ error: e.message || "REQUEST_REJECTED" }, status);
    }
  }
};
export { OURHOSTSELFState } from "./state.js";
