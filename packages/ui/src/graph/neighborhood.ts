import type { EdgeKind, Graph } from "@epoch-dev/core";
import { isHintEdge, isShownEdge } from "./aggregate";

/*
 * The files around one file: what it imports (directly or within a few hops)
 * and what imports it. It follows the edges the graph view draws (the
 * default display set of CLAUDE.md "Edge traversal policy"), so the dependents
 * side beyond one hop is a preview, not blast radius, which M4 computes in
 * core with its own policy. Pure, for the tests and the static demo.
 */

export interface NeighborhoodOptions {
  readonly hops: 1 | 2 | 3;
  readonly showViaBarrel: boolean;
}

export interface Neighbor {
  readonly id: string;
  /** Hops from the center along imports (the center depends on it). */
  readonly importDepth?: number;
  /** The file one hop closer on the imports side (the first by id). */
  readonly importVia?: string;
  /** Hops from the center along dependents (it depends on the center). */
  readonly dependentDepth?: number;
  readonly dependentVia?: string;
}

export interface NeighborEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kinds: readonly EdgeKind[];
  readonly hint: boolean;
  /** Leads away from the center (a step of the neighborhood), not between neighbors. */
  readonly outward: boolean;
}

export interface Neighborhood {
  readonly center: string;
  /** Sorted by id. */
  readonly neighbors: readonly Neighbor[];
  /** The drawn edges among the center and its neighbors, merged per pair, sorted by id. */
  readonly edges: readonly NeighborEdge[];
}

export type Side = "imports" | "dependents" | "both";

export const sideOf = (n: Neighbor): Side =>
  n.importDepth === undefined
    ? "dependents"
    : n.dependentDepth === undefined
      ? "imports"
      : "both";

type Adjacency = Map<string, string[]>;

/** Breadth-first distances from `start`, with each node's predecessor (the first by id). */
function bfs(
  adjacency: Adjacency,
  start: string,
  hops: number,
): Map<string, { depth: number; via: string }> {
  const out = new Map<string, { depth: number; via: string }>();
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 1; depth <= hops && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const from of frontier) {
      for (const to of adjacency.get(from) ?? []) {
        if (seen.has(to)) continue;
        seen.add(to);
        out.set(to, { depth, via: from });
        next.push(to);
      }
    }
    frontier = next.sort();
  }
  return out;
}

export function neighborhood(
  graph: Graph,
  center: string,
  options: NeighborhoodOptions,
): Neighborhood {
  const shown = graph.edges.filter(
    (e) => e.source !== e.target && isShownEdge(e, options.showViaBarrel),
  );
  const forward: Adjacency = new Map();
  const backward: Adjacency = new Map();
  const link = (adjacency: Adjacency, from: string, to: string) => {
    const list = adjacency.get(from);
    if (list) list.push(to);
    else adjacency.set(from, [to]);
  };
  for (const e of shown) {
    link(forward, e.source, e.target);
    link(backward, e.target, e.source);
  }
  for (const list of [...forward.values(), ...backward.values()]) list.sort();

  const imports = bfs(forward, center, options.hops);
  const dependents = bfs(backward, center, options.hops);
  const ids = [...new Set([...imports.keys(), ...dependents.keys()])].sort();
  const neighbors: Neighbor[] = ids.map((id) => {
    const i = imports.get(id);
    const d = dependents.get(id);
    return {
      id,
      ...(i ? { importDepth: i.depth, importVia: i.via } : {}),
      ...(d ? { dependentDepth: d.depth, dependentVia: d.via } : {}),
    };
  });

  const importDepth = (id: string) =>
    id === center ? 0 : imports.get(id)?.depth;
  const dependentDepth = (id: string) =>
    id === center ? 0 : dependents.get(id)?.depth;
  const members = new Set([center, ...ids]);
  const merged = new Map<
    string,
    {
      source: string;
      target: string;
      hint: boolean;
      kinds: Set<EdgeKind>;
      outward: boolean;
    }
  >();
  for (const e of shown) {
    if (!members.has(e.source) || !members.has(e.target)) continue;
    const hint = isHintEdge(e);
    const si = importDepth(e.source);
    const ti = importDepth(e.target);
    const sd = dependentDepth(e.source);
    const td = dependentDepth(e.target);
    const outward =
      (si !== undefined && ti === si + 1) ||
      (td !== undefined && sd === td + 1);
    const id = `${e.source}->${e.target}${hint ? " (hint)" : ""}`;
    const m = merged.get(id);
    if (m) {
      m.kinds.add(e.kind);
      m.outward ||= outward;
    } else {
      merged.set(id, {
        source: e.source,
        target: e.target,
        hint,
        kinds: new Set([e.kind]),
        outward,
      });
    }
  }
  const edges: NeighborEdge[] = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, m]) => ({
      id,
      source: m.source,
      target: m.target,
      kinds: [...m.kinds].sort(),
      hint: m.hint,
      outward: m.outward,
    }));

  return { center, neighbors, edges };
}
