import type { EdgeKind, Graph, GraphEdge, GraphNode } from "@epoch-dev/core";

/* Small graph builders shared by the graph view tests. */

export const node = (id: string, language = "typescript"): GraphNode => ({
  id,
  kind: id.startsWith("pkg:") ? "package" : "file",
  language,
  loc: 1,
  contentHash: "h",
  exports: [],
  externals: [],
  flags: [],
  metrics: { fanIn: 0, fanOut: 0 },
});

export const edge = (
  source: string,
  target: string,
  kind: EdgeKind = "import",
  confidence = 1,
): GraphEdge => ({
  source,
  target,
  kind,
  provenance: confidence < 1 ? "git-cochange" : "resolver",
  confidence,
  evidence: [],
});

export const graph = (nodes: string[], edges: GraphEdge[] = []): Graph => ({
  schemaVersion: 1,
  nodes: nodes.map((id) => node(id)),
  edges,
  roots: [],
  findings: [],
  unresolved: [],
});
