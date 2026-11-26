const encoder = new TextEncoder();
const COMMAND_DOMAIN = encoder.encode("OURSELF-PIPE-PORTAL-COMMAND-JCS-RFC8785-V1\0");

function assertUnicodeScalarString(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("WITNESS_UNICODE_INVALID");
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error("WITNESS_UNICODE_INVALID");
  }
}
function normalize(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { assertUnicodeScalarString(value); return value; }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      assertUnicodeScalarString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") || descriptor.value === undefined) throw new Error("WITNESS_OBJECT_VALUE_INVALID");
      out[key] = normalize(descriptor.value);
    }
    return out;
  }
  throw new Error("WITNESS_CANONICAL_VALUE_INVALID");
}
export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
export async function signDeliveryEnvelope(payload, privatePem) {
  const body = encoder.encode(canonicalJson(payload));
  const signed = concat(COMMAND_DOMAIN, body);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", signed));
  const keyBytes = Uint8Array.from(atob(privatePem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", keyBytes, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, signed));
  return {
    algorithm: "Ed25519", payload, payload_encoding: "OURSELF-JCS-RFC8785-V1",
    payload_byte_length: body.length,
    payload_digest: [...digest].map(v => v.toString(16).padStart(2, "0")).join(""),
    signature: toBase64Url(signature)
  };
}
export async function verifyDeviceRequest({ timestamp, nonce, body, signature, publicPem }) {
  if (!/^\d{10,11}$/.test(String(timestamp)) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 60) throw new Error("DEVICE_TIMESTAMP_INVALID");
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(String(nonce))) throw new Error("DEVICE_NONCE_INVALID");
  if (!/^[A-Za-z0-9_-]{80,128}$/.test(String(signature))) throw new Error("DEVICE_SIGNATURE_INVALID");
  const raw = encoder.encode(String(body));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const hex = [...digest].map(v => v.toString(16).padStart(2, "0")).join("");
  const message = encoder.encode([timestamp, nonce, hex].join("."));
  const keyBytes = Uint8Array.from(atob(publicPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("spki", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - signature.length % 4) % 4)), c => c.charCodeAt(0));
  if (!await crypto.subtle.verify("Ed25519", key, sig, message)) throw new Error("DEVICE_SIGNATURE_INVALID");
  return { body_digest: hex, timestamp: Number(timestamp), nonce };
}
