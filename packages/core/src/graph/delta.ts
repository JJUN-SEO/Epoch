import { canonicalJson } from "../cache/canonical-json.js";
import { canonicalizeGraph } from "../canonical.js";
import type { GraphDelta } from "../interfaces/api.js";
import type { Graph, GraphEdge } from "../schemas/index.js";

const edgeKey = (e: Pick<GraphEdge, "source" | "target" | "kind">): string =>
  `${e.source}\u0000${e.target}\u0000${e.kind}`;

/** True when the delta changes nothing. */
export function isEmptyDelta(d: GraphDelta): boolean {
  return (
    d.upsertNodes.length === 0 &&
    d.removeNodes.length === 0 &&
    d.upsertEdges.length === 0 &&
    d.removeEdges.length === 0 &&
    d.roots === undefined &&
    d.findings === undefined &&
    d.unresolved === undefined
  );
}

/**
 * What turns `prev` into `next`: nodes and edges added, changed or removed
 * (compared by value), and the small lists in full when they differ. Pure,
 * so the analysis host computes it and main and the renderer apply it.
 */
export function diffGraphs(prev: Graph, next: Graph): GraphDelta {
  const before = new Map(prev.nodes.map((n) => [n.id, canonicalJson(n)]));
  const upsertNodes = next.nodes.filter(
    (n) => before.get(n.id) !== canonicalJson(n),
  );
  const nextIds = new Set(next.nodes.map((n) => n.id));
  const removeNodes = prev.nodes
    .map((n) => n.id)
    .filter((id) => !nextIds.has(id));

  const beforeEdges = new Map(
    prev.edges.map((e) => [edgeKey(e), canonicalJson(e)]),
  );
  const upsertEdges = next.edges.filter(
    (e) => beforeEdges.get(edgeKey(e)) !== canonicalJson(e),
  );
  const nextEdges = new Set(next.edges.map(edgeKey));
  const removeEdges = prev.edges
    .filter((e) => !nextEdges.has(edgeKey(e)))
    .map((e) => ({ source: e.source, target: e.target, kind: e.kind }));

  const changed = <T>(a: readonly T[], b: readonly T[]) =>
    canonicalJson(a) !== canonicalJson(b);
  return {
    upsertNodes,
    removeNodes,
    upsertEdges,
    removeEdges,
    ...(changed(prev.roots, next.roots) ? { roots: next.roots } : {}),
    ...(changed(prev.findings, next.findings)
      ? { findings: next.findings }
      : {}),
    ...(changed(prev.unresolved, next.unresolved)
      ? { unresolved: next.unresolved }
      : {}),
  };
}

/** Applies a delta from diffGraphs; the result is canonical. */
export function applyDelta(graph: Graph, delta: GraphDelta): Graph {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const id of delta.removeNodes) nodes.delete(id);
  for (const n of delta.upsertNodes) nodes.set(n.id, n);
  const edges = new Map(graph.edges.map((e) => [edgeKey(e), e]));
  for (const e of delta.removeEdges) edges.delete(edgeKey(e));
  for (const e of delta.upsertEdges) edges.set(edgeKey(e), e);
  return canonicalizeGraph({
    ...graph,
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    roots: [...(delta.roots ?? graph.roots)],
    findings: [...(delta.findings ?? graph.findings)],
    unresolved: [...(delta.unresolved ?? graph.unresolved)],
  });
}
