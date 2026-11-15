import { UndirectedGraph } from "graphology";
import louvainModule from "graphology-communities-louvain";
import { compareCodeUnits } from "../canonical.js";
import { CERTAIN_EDGE_KINDS, isHintEdge } from "../policy.js";
import type { Graph } from "../schemas/index.js";

// The package is CommonJS (`module.exports = fn`) with types that declare a
// default export, so NodeNext types the import as the module, not as the
// function it is at run time.
const louvain = louvainModule as unknown as typeof louvainModule.default;

export interface Cluster {
  /** 0 for the largest cluster, then by size, then by label. */
  readonly index: number;
  /** The id of its most depended-on node. */
  readonly label: string;
  /** Node ids, sorted. */
  readonly members: readonly string[];
}

export interface Clusters {
  readonly clusters: readonly Cluster[];
  /** Node id to cluster index; a node with no certain edge has none. */
  readonly of: ReadonlyMap<string, number>;
}

/**
 * Groups of nodes that depend mostly on each other (CLAUDE.md "Graph
 * queries", ADR-021): Louvain over the certain edge set, read as undirected.
 * Nodes and edges are added in id order and the traversal is not random, so
 * the same graph always gives the same clusters. A view only: clusters are
 * never facts, findings, or inputs to risk, and are not stored in the Graph.
 */
export function clusters(graph: Graph): Clusters {
  const pairs = new Set<string>();
  for (const e of graph.edges) {
    if (
      e.source === e.target ||
      isHintEdge(e) ||
      !CERTAIN_EDGE_KINDS.has(e.kind)
    )
      continue;
    const [a, b] =
      compareCodeUnits(e.source, e.target) < 0
        ? [e.source, e.target]
        : [e.target, e.source];
    pairs.add(`${a}\u0000${b}`);
  }
  const g = new UndirectedGraph();
  for (const pair of [...pairs].sort(compareCodeUnits)) {
    const [a = "", b = ""] = pair.split("\u0000");
    g.mergeNode(a);
    g.mergeNode(b);
    g.addEdge(a, b);
  }
  if (g.order === 0) return { clusters: [], of: new Map() };

  const community = louvain(g, { randomWalk: false, getEdgeWeight: null });
  const groups = new Map<number, string[]>();
  for (const id of Object.keys(community).sort(compareCodeUnits)) {
    const c = community[id];
    if (c === undefined) continue;
    const members = groups.get(c);
    if (members) members.push(id);
    else groups.set(c, [id]);
  }

  const weight = new Map(
    graph.nodes.map((n) => [
      n.id,
      [n.metrics.dependents ?? n.metrics.fanIn, n.metrics.fanIn] as const,
    ]),
  );
  const labelOf = (members: readonly string[]): string =>
    [...members].sort((a, b) => {
      const [da = 0, fa = 0] = weight.get(a) ?? [];
      const [db = 0, fb = 0] = weight.get(b) ?? [];
      return db - da || fb - fa || compareCodeUnits(a, b);
    })[0] ?? "";

  const ordered = [...groups.values()]
    .map((members) => ({ members, label: labelOf(members) }))
    .sort(
      (a, b) =>
        b.members.length - a.members.length ||
        compareCodeUnits(a.label, b.label),
    )
    .map((c, index) => ({ index, ...c }));
  const of = new Map<string, number>();
  for (const c of ordered) for (const id of c.members) of.set(id, c.index);
  return { clusters: ordered, of };
}
