import crypto from "node:crypto";

export const EVIDENCE_SPECIES = Object.freeze([
  "DECLARATION",
  "SOURCE",
  "BUILD",
  "VERIFY",
  "BIRTH",
  "ACTUATION",
  "OBSERVATION",
  "EVIDENCE",
  "RECEIPT",
  "MEMORY",
  "RECONTACT",
  "TERMINATION"
]);

const REQUIRED = new Set(EVIDENCE_SPECIES);

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortValue(entry)])
    );
  }
  return value;
};

export const canonicalize = (value) => JSON.stringify(sortValue(value));

export const sha256 = (value) =>
  crypto.createHash("sha256")
    .update(typeof value === "string" ? value : canonicalize(value), "utf8")
    .digest("hex");

export function assertSpecies(species) {
  if (!REQUIRED.has(species)) throw new Error(`EVIDENCE_SPECIES_INVALID:${species}`);
}

export function createEvidence({
  species,
  instance_id,
  parent_evidence_id = null,
  parent_event_hash = null,
  timestamp,
  source,
  operation = null,
  state = null,
  payload
}) {
  assertSpecies(species);
  if (!instance_id) throw new Error("INSTANCE_ID_REQUIRED");
  if (!timestamp) throw new Error("TIMESTAMP_REQUIRED");
  if (!source) throw new Error("SOURCE_REQUIRED");

  const canonicalPayload = canonicalize(payload);
  const payloadSha256 = sha256(canonicalPayload);
  const eventMaterial = {
    species,
    instance_id,
    parent_evidence_id,
    parent_event_hash,
    timestamp,
    source,
    operation,
    state,
    payload_sha256: payloadSha256,
    payload
  };

  return Object.freeze({
    evidence_id: `evidence-${crypto.randomUUID()}`,
    species,
    instance_id,
    parent_evidence_id,
    parent_event_hash,
    timestamp,
    source,
    operation,
    state,
    payload,
    payload_sha256: payloadSha256,
    event_hash: sha256(eventMaterial)
  });
}

export function assertChainLink(previous, current) {
  if (!previous || !current) throw new Error("CHAIN_NODE_REQUIRED");
  if (current.parent_evidence_id !== previous.evidence_id) {
    throw new Error("PARENT_EVIDENCE_MISMATCH");
  }
  if (current.parent_event_hash !== previous.event_hash) {
    throw new Error("PARENT_EVENT_HASH_MISMATCH");
  }
  return true;
}

export function createEvidenceGraph({ instance_id, source, timestampFactory = () => new Date().toISOString() } = {}) {
  if (!instance_id) throw new Error("INSTANCE_ID_REQUIRED");
  if (!source) throw new Error("SOURCE_REQUIRED");

  const nodes = [];

  const append = ({ species, operation = null, state = null, payload }) => {
    const previous = nodes.at(-1) || null;
    const node = createEvidence({
      species,
      instance_id,
      parent_evidence_id: previous?.evidence_id ?? null,
      parent_event_hash: previous?.event_hash ?? null,
      timestamp: timestampFactory(),
      source,
      operation,
      state,
      payload
    });
    if (previous) assertChainLink(previous, node);
    nodes.push(node);
    return node;
  };

  return Object.freeze({
    append,
    nodes: () => nodes.map((node) => structuredClone(node)),
    head: () => structuredClone(nodes.at(-1) ?? null)
  });
}
