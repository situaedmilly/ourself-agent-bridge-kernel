import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const graph = JSON.parse(readFileSync(resolve(root, "specifications/selfgraph-agentbridge/AGENTBRIDGE-SELFGRAPH.v0.1.json"), "utf8"));
const sourceLines = readFileSync(resolve(root, "specifications/selfgraph-agentbridge/AGENTBRIDGE-SOURCE-MANIFEST.v0.1.tsv"), "utf8")
  .split("\n").filter((line) => line && !line.startsWith("#"));

test("AGENTBRIDGE graph is explicitly manifested", () => {
  assert.equal(graph.graph_id, "AGENTBRIDGE");
  assert.equal(graph.version, "0.1.0");
  assert.equal(graph.artifact_status, "MANIFESTED_WITH_EXACT_SOURCE_BINDINGS");
});

test("source custody is exact-file/blob bound", () => {
  assert.equal(sourceLines.length, 42);
  for (const line of sourceLines) {
    const [id, repo, path, ref, commit, blobSha, binding] = line.split("|");
    assert.match(id, /^SRC-[0-9]{3}$/);
    assert.ok(repo);
    assert.ok(path);
    assert.ok(ref);
    assert.match(commit, /^[0-9a-f]{40}$/);
    assert.match(blobSha, /^[0-9a-f]{40}$/);
    assert.equal(binding, "EXACT_FILE_BLOB");
  }
});

test("required AgentBridge jurisdictions are represented", () => {
  const ids = new Set(graph.nodes.map((node) => node.node_id));
  for (const required of [
    "MODELSELF","AGENTBRIDGE-PROFILE","AGENTBRIDGE-CONTRACT",
    "BRIDGESELF","OURSELFD-CORE","TERMINAL-APPROVAL-BRIDGE",
    "RUNTIMESELF-ORCHESTRATOR","OURSELFMCP-BRIDGE",
    "CAUSAL-ACTUATION","IDENTITYSELF","ADMISSIONSELF","AUTHORITYSELF"
  ]) assert.ok(ids.has(required), "missing " + required);
});

test("graph does not claim runtime realization or grant authority", () => {
  assert.equal(graph.runtime_realization, "NOT_ESTABLISHED");
  assert.equal(graph.standing.authority_grant_by_graph, "FORBIDDEN");
  assert.equal(graph.standing.effect_claim_without_authority_and_witness, "FORBIDDEN");
});

test("every edge resolves to an existing graph node", () => {
  const ids = new Set(graph.nodes.map((node) => node.node_id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source), edge.id + " source unresolved");
    assert.ok(ids.has(edge.target), edge.id + " target unresolved");
  }
});
