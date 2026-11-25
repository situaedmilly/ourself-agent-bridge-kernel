import crypto from "node:crypto";

export const COMMAND_ENCODING = "OURSELF-JCS-RFC8785-V1";
const COMMAND_DOMAIN = Buffer.from("OURSELF-PIPE-PORTAL-COMMAND-V1\0", "utf8");

function assertUnicodeScalarString(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error("JCS_INVALID_UNICODE");
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("JCS_INVALID_UNICODE");
    }
  }
}

function normalize(value, path = "$") {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS_NONFINITE_NUMBER");
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) throw new Error("JCS_SPARSE_ARRAY");
    }
    return value.map((item, i) => normalize(item, path + "[" + i + "]"));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("JCS_NON_PLAIN_OBJECT");
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      assertUnicodeScalarString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw new Error("JCS_ACCESSOR_REJECTED");
      }
      if (descriptor.value === undefined) throw new Error("JCS_UNDEFINED_REJECTED");
      out[key] = normalize(descriptor.value, path + "." + key);
    }
    return out;
  }
  throw new Error("JCS_TYPE_REJECTED");
}

export function canonicalJsonStringify(value) {
  return JSON.stringify(normalize(value));
}

export function canonicalJsonBytes(value) {
  return Buffer.from(canonicalJsonStringify(value), "utf8");
}

export function parseCanonicalJson(rawBytes) {
  const bytes = Buffer.isBuffer(rawBytes) ? rawBytes : Buffer.from(rawBytes);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("JCS_UTF8_INVALID");
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("JCS_PARSE_INVALID");
  }
  const canonical = canonicalJsonStringify(value);
  if (canonical !== source) throw new Error("JCS_BYTES_MISMATCH");
  return value;
}

export function commandDigest(bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return crypto.createHash("sha256").update(COMMAND_DOMAIN).update(body).digest("hex");
}

export function verifyCommandBytes({ bytes, encoding, byteLength, digest }) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (encoding !== COMMAND_ENCODING) throw new Error("COMMAND_ENCODING_INVALID");
  if (!Number.isSafeInteger(byteLength) || byteLength !== body.length) throw new Error("COMMAND_BYTE_LENGTH_INVALID");
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("COMMAND_DIGEST_INVALID");
  const expected = Buffer.from(commandDigest(body), "hex");
  const actual = Buffer.from(digest, "hex");
  if (!crypto.timingSafeEqual(expected, actual)) throw new Error("COMMAND_DIGEST_MISMATCH");
  return true;
}
