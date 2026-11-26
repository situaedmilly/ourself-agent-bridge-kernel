import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const PROTOCOLSELF_REGISTRY_SHA256 = "76a2a14c9bab0d0ded7ff05c80991141df53e9f1f15ec948443e0b950017508c";
const registryPath = resolve(dirname(fileURLToPath(import.meta.url)), "../protocols/protocolself-18.v0.1.json");

export function bootProtocolSelfRegistry() {
  const bytes = readFileSync(registryPath);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== PROTOCOLSELF_REGISTRY_SHA256) throw new Error("PROTOCOLSELF_SOURCE_DIGEST_MISMATCH");
  const registry = JSON.parse(bytes.toString("utf8"));
  if (registry.registry_id !== "OURSELFCOMM-PROTOCOLSELF-18" || registry.protocols?.length !== 18) throw new Error("PROTOCOLSELF_REGISTRY_SHAPE_INVALID");
  if (registry.protocols.some(p => p.listener_enabled !== false || p.external_exposure !== false || p.admission_required !== true)) throw new Error("PROTOCOLSELF_LISTENER_POLICY_VIOLATION");
  if (registry.boot_policy?.network_transport_authority !== "NOT_GRANTED_BY_REGISTRY_BOOT") throw new Error("PROTOCOLSELF_AUTHORITY_BOUNDARY_INVALID");
  return Object.freeze({
    registry_id: registry.registry_id,
    source_sha256: actual,
    status: "REGISTRY_BOOTED_LISTENERS_DISABLED",
    protocol_count: registry.protocols.length,
    network_listeners_started: 0,
    external_bindings_created: 0,
    network_transport_authority: "NOT_GRANTED"
  });
}
