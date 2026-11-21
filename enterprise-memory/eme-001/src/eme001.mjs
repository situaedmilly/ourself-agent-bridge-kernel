import { createHash, sign as cryptoSign, verify as cryptoVerify } from "node:crypto";
import { open, readFile } from "node:fs/promises";

const PROFILE = "EME-CJ-1";
const DOMAIN = "OURSELF:EME-001:v0.1";
const HEX_256 = /^[a-f0-9]{64}$/;

function normalize(value, path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(`Only safe integers are permitted at ${path}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new TypeError(`Unsafe object key at ${path}.${key}`);
      }
      if (value[key] === undefined) throw new TypeError(`Undefined value at ${path}.${key}`);
      out[key] = normalize(value[key], `${path}.${key}`);
    }
    return out;
  }
  throw new TypeError(`Unsupported JSON value at ${path}`);
}

export function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

function domainBytes(objectType, canonicalBytes) {
  return Buffer.concat([
    Buffer.from(`${DOMAIN}:${objectType}\0`, "utf8"),
    Buffer.from(canonicalBytes, "utf8")
  ]);
}

export function hashObject(objectType, value) {
  if (typeof objectType !== "string" || !objectType) throw new TypeError("objectType is required");
  return createHash("sha256").update(domainBytes(objectType, canonicalize(value))).digest("hex");
}

export function signObject(objectType, value, privateKey, keyId) {
  if (!keyId) throw new TypeError("keyId is required");
  const bytes = domainBytes(objectType, canonicalize(value));
  return {
    algorithm: "Ed25519",
    key_id: keyId,
    signed_object_hash: createHash("sha256").update(bytes).digest("hex"),
    signature_b64: cryptoSign(null, bytes, privateKey).toString("base64")
  };
}

export function verifyObjectSignature(objectType, value, signature, publicKey) {
  if (!signature || signature.algorithm !== "Ed25519" || !HEX_256.test(signature.signed_object_hash ?? "")) return false;
  try {
    const bytes = domainBytes(objectType, canonicalize(value));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== signature.signed_object_hash) return false;
    return cryptoVerify(null, bytes, publicKey, Buffer.from(signature.signature_b64, "base64"));
  } catch {
    return false;
  }
}

function eventBody(event) {
  const { content_hash: _contentHash, ...body } = event;
  return body;
}

export function createEvent(input) {
  const body = {
    spec_version: "EME-001/v0.1",
    object_type: "EnterpriseMemoryEvent",
    event_id: input.event_id,
    enterprise_id: input.enterprise_id,
    sequence: input.sequence,
    event_type: input.event_type,
    subject: input.subject,
    recorded_at: input.recorded_at,
    ...(input.effective_at === undefined ? {} : { effective_at: input.effective_at }),
    source_identity_ref: input.source_identity_ref,
    state_operations: input.state_operations ?? [],
    evidence_refs: input.evidence_refs ?? [],
    ...(input.authority_attestation_ref === undefined ? {} : { authority_attestation_ref: input.authority_attestation_ref }),
    ...(input.causal_parent_event_id === undefined ? {} : { causal_parent_event_id: input.causal_parent_event_id }),
    ...(input.supersedes_event_id === undefined ? {} : { supersedes_event_id: input.supersedes_event_id }),
    previous_event_hash: input.previous_event_hash ?? null
  };
  const event = { ...body, content_hash: hashObject("EnterpriseMemoryEvent", body) };
  validateEvent(event);
  return event;
}

export function verifyEventIntegrity(event) {
  if (!event || typeof event !== "object" || !HEX_256.test(event.content_hash ?? "")) return false;
  try {
    return hashObject("EnterpriseMemoryEvent", eventBody(event)) === event.content_hash;
  } catch {
    return false;
  }
}

export function validateEvent(event) {
  const required = ["event_id", "enterprise_id", "event_type", "subject", "recorded_at", "source_identity_ref"];
  for (const key of required) {
    if (typeof event?.[key] !== "string" || event[key].length === 0) throw new TypeError(`Invalid event field: ${key}`);
  }
  if (event.spec_version !== "EME-001/v0.1" || event.object_type !== "EnterpriseMemoryEvent") throw new TypeError("Unsupported event envelope");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) throw new TypeError("sequence must be a positive safe integer");
  if (!Number.isFinite(Date.parse(event.recorded_at))) throw new TypeError("recorded_at must be a valid timestamp");
  if (!Array.isArray(event.state_operations) || !Array.isArray(event.evidence_refs)) throw new TypeError("state_operations and evidence_refs must be arrays");
  if (event.previous_event_hash !== null && !HEX_256.test(event.previous_event_hash)) throw new TypeError("Invalid previous_event_hash");
  if (!verifyEventIntegrity(event)) throw new TypeError("Event content hash mismatch");
  return true;
}

export function verifyEventChain(events) {
  let previous = null;
  let sequence = 1;
  const ids = new Set();
  for (const event of events) {
    validateEvent(event);
    if (event.sequence !== sequence) throw new Error(`Sequence discontinuity at ${event.event_id}`);
    if (event.previous_event_hash !== previous) throw new Error(`Previous hash mismatch at ${event.event_id}`);
    if (ids.has(event.event_id)) throw new Error(`Duplicate event ID: ${event.event_id}`);
    ids.add(event.event_id);
    previous = event.content_hash;
    sequence += 1;
  }
  return { valid: true, count: events.length, head_hash: previous };
}

export class AppendOnlyJournal {
  #path;
  #events;
  #tail = Promise.resolve();

  constructor(path, events) {
    this.#path = path;
    this.#events = events;
  }

  static async open(path) {
    const handle = await open(path, "a");
    await handle.close();
    let contents = "";
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const lines = contents.split("\n").filter(Boolean);
    const events = lines.map((line, index) => {
      try { return JSON.parse(line); }
      catch { throw new Error(`Malformed journal line ${index + 1}`); }
    });
    verifyEventChain(events);
    return new AppendOnlyJournal(path, events);
  }

  get head() {
    return this.#events.length ? this.#events[this.#events.length - 1].content_hash : null;
  }

  get length() {
    return this.#events.length;
  }

  list() {
    return this.#events.map((event) => structuredClone(event));
  }

  append(event) {
    const operation = this.#tail.then(async () => {
      validateEvent(event);
      const expectedSequence = this.#events.length + 1;
      if (event.sequence !== expectedSequence) throw new Error("Append sequence mismatch");
      if (event.previous_event_hash !== this.head) throw new Error("Append previous hash mismatch");
      if (this.#events.some((existing) => existing.event_id === event.event_id)) throw new Error("Duplicate event ID");
      const line = `${canonicalize(event)}\n`;
      const handle = await open(this.#path, "a");
      try {
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.#events.push(structuredClone(event));
      return { appended: true, event_id: event.event_id, content_hash: event.content_hash };
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
}

function pathParts(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer === "/") throw new TypeError("Only non-root JSON pointers are supported");
  const parts = pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) throw new TypeError("Unsafe state path");
  return parts;
}

function applyOperation(state, operation) {
  if (!operation || !["set", "remove"].includes(operation.op)) throw new TypeError("Unsupported replay operation");
  const parts = pathParts(operation.path);
  let cursor = state;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(cursor, part)) {
      if (operation.op === "remove") return;
      cursor[part] = {};
    }
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) throw new TypeError("Replay path crosses a non-object value");
    cursor = cursor[part];
  }
  const leaf = parts[parts.length - 1];
  if (operation.op === "remove") delete cursor[leaf];
  else {
    normalize(operation.value);
    cursor[leaf] = structuredClone(operation.value);
  }
}

/** Pure historical state projection. This module intentionally exposes no actuation interface. */
export function replayEvents(events, initialState = {}) {
  verifyEventChain(events);
  const state = structuredClone(normalize(initialState));
  for (const event of events) {
    for (const operation of event.state_operations) applyOperation(state, operation);
  }
  return state;
}

export const EME_PROFILE = PROFILE;
