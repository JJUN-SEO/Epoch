import { compareCodeUnits } from "../canonical.js";
import type { BlastRadiusOptions } from "../interfaces/api.js";
import { isHintEdge } from "../policy.js";
import type {
  EdgeKind,
  Graph,
  GraphEdge,
  GraphNode,
} from "../schemas/index.js";
import { edgeFilters } from "./blast-radius.js";

export type DependencyPathOptions = Pick<
  BlastRadiusOptions,
  "mode" | "includeTypeOnly" | "hintThreshold"
>;

/** One edge of a dependency path: `source` depends on `target`. */
export interface DependencyPathHop {
  readonly source: string;
  readonly target: string;
  readonly kind: EdgeKind;
  readonly evidence: readonly string[];
  /** An inferred edge, not a resolver-proven one. */
  readonly hint: boolean;
  readonly confidence: number;
}

export interface DependencyPath {
  readonly from: string;
  readonly to: string;
  /** `from` first, `to` last. */
  readonly nodes: readonly string[];
  readonly hops: readonly DependencyPathHop[];
  /** How many hops are hint edges: 0 for a chain of facts. */
  readonly viaHints: number;
}

/** Between two nodes, the edge a path shows: the plainest fact first. */
const KIND_ORDER: readonly EdgeKind[] = [
  "import",
  "reexport",
  "dynamic-import",
  "type-only",
];

function better(a: GraphEdge, b: GraphEdge): boolean {
  const hint = Number(isHintEdge(a)) - Number(isHintEdge(b));
  if (hint !== 0) return hint < 0;
  if (a.confidence !== b.confidence) return a.confidence > b.confidence;
  const rank = (e: GraphEdge) => {
    const i = KIND_ORDER.indexOf(e.kind);
    return i === -1 ? KIND_ORDER.length : i;
  };
  return rank(a) - rank(b) < 0 || (rank(a) === rank(b) && a.kind < b.kind);
}

/** The shortest chain from `from` to `to` over the edges `follow` accepts. */
function shortest(
  graph: Graph,
  from: string,
  to: string,
  follow: (e: GraphEdge) => boolean,
): GraphEdge[] | undefined {
  const out = new Map<string, Map<string, GraphEdge>>();
  for (const e of graph.edges) {
    if (e.source === e.target || !follow(e)) continue;
    let targets = out.get(e.source);
    if (!targets) {
      targets = new Map();
      out.set(e.source, targets);
    }
    const seen = targets.get(e.target);
    if (!seen || better(e, seen)) targets.set(e.target, e);
  }
  // Breadth-first, neighbors in id order: the first chain found is the
  // shortest, and among the shortest the same one for the same graph.
  const via = new Map<string, GraphEdge>();
  const seen = new Set([from]);
  let frontier = [from];
  while (frontier.length > 0 && !seen.has(to)) {
    const next: string[] = [];
    for (const node of frontier) {
      const targets = out.get(node);
      if (!targets) continue;
      for (const target of [...targets.keys()].sort(compareCodeUnits)) {
        if (seen.has(target)) continue;
        seen.add(target);
        const edge = targets.get(target);
        if (edge) via.set(target, edge);
        next.push(target);
      }
    }
    frontier = next.sort(compareCodeUnits);
  }
  if (!seen.has(to)) return undefined;
  const chain: GraphEdge[] = [];
  for (let at = to; at !== from;) {
    const edge = via.get(at);
    if (!edge) return undefined;
    chain.unshift(edge);
    at = edge.source;
  }
  return chain;
}

/**
 * How `from` depends on `to` (CLAUDE.md "Graph queries"): the shortest chain
 * of edges over blast radius's edge kinds, or null when `from` does not
 * depend on `to`. A chain of fact edges is preferred; in likely mode a chain
 * that needs hint edges is given only when no fact chain exists. Pure and
 * deterministic.
 */
export function dependencyPath(
  graph: Graph,
  from: string,
  to: string,
  opts: DependencyPathOptions,
): DependencyPath | null {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const id of [from, to]) {
    if (!ids.has(id)) throw new Error(`No node ${id} in the graph.`);
  }
  const { fact, followed } = edgeFilters(opts);
  if (from === to) return { from, to, nodes: [from], hops: [], viaHints: 0 };
  const chain =
    shortest(graph, from, to, fact) ??
    (opts.mode === "likely" ? shortest(graph, from, to, followed) : undefined);
  if (!chain) return null;
  const hops = chain.map((e) => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
    evidence: e.evidence,
    hint: isHintEdge(e),
    confidence: e.confidence,
  }));
  return {
    from,
    to,
    nodes: [from, ...hops.map((h) => h.target)],
    hops,
    viaHints: hops.filter((h) => h.hint).length,
  };
}

/**
 * The nodes most of the project depends on: by transitive dependents, then
 * direct importers, then id. Nodes nothing depends on are left out.
 */
export function mostDependedOn(graph: Graph, limit: number): GraphNode[] {
  return graph.nodes
    .filter((n) => (n.metrics.dependents ?? n.metrics.fanIn) > 0)
    .sort(
      (a, b) =>
        (b.metrics.dependents ?? b.metrics.fanIn) -
          (a.metrics.dependents ?? a.metrics.fanIn) ||
        b.metrics.fanIn - a.metrics.fanIn ||
        compareCodeUnits(a.id, b.id),
    )
    .slice(0, Math.max(0, limit));
}
