import test from "node:test";
import assert from "node:assert/strict";
import { bootProtocolSelfRegistry } from "../runtime/protocolself-registry.mjs";

test("AgentBridge kernel boots the pinned 18-entry ProtocolSELF registry without listeners", () => {
  const boot = bootProtocolSelfRegistry();
  assert.equal(boot.registry_id, "OURSELFCOMM-PROTOCOLSELF-18");
  assert.equal(boot.protocol_count, 18);
  assert.equal(boot.status, "REGISTRY_BOOTED_LISTENERS_DISABLED");
  assert.equal(boot.network_listeners_started, 0);
  assert.equal(boot.external_bindings_created, 0);
  assert.equal(boot.network_transport_authority, "NOT_GRANTED");
});
