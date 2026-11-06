import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const graph = JSON.parse(readFileSync(resolve(root, "specifications/selfgraph-agentbridge/AGENTBRIDGE-SELFGRAPH.v0.1.json"), "utf8"));
const sources = readFileSync(resolve(root, "specifications/selfgraph-agentbridge/AGENTBRIDGE-SOURCE-MANIFEST.v0.1.tsv"), "utf8")
  .split("\n").filter((line) => line && !line.startsWith("#"));

const sourceIds = new Set(sources.map((line) => line.split("|")[0]));
const nodeIds = new Set((graph.nodes ?? []).map((node) => node.node_id));

const unresolvedSources = (graph.nodes ?? []).flatMap((node) =>
  (node.source_ids ?? []).filter((id) => !sourceIds.has(id)).map((id) => ({ node: node.node_id, source: id }))
);

const unresolvedEdges = (graph.edges ?? []).filter((edge) =>
  !nodeIds.has(edge.source) || !nodeIds.has(edge.target)
).map((edge) => edge.id);

const result = {
  graph_id: graph.graph_id,
  version: graph.version,
  source_bindings: sources.length,
  nodes: graph.nodes?.length ?? 0,
  edges: graph.edges?.length ?? 0,
  unresolved_sources: unresolvedSources,
  unresolved_edges: unresolvedEdges,
  runtime_realization: graph.runtime_realization,
  graph_does_not_grant_authority: graph.standing?.authority_grant_by_graph === "FORBIDDEN"
};

console.log(JSON.stringify(result, null, 2));
