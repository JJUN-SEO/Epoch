import type { EdgeKind, Graph } from "../schemas/index.js";

type Adjacency = ReadonlyMap<string, readonly string[]>;

function adjacency(
  g: Graph,
  kinds: ReadonlySet<EdgeKind>,
  direction: "forward" | "reverse",
): Adjacency {
  const adj = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!kinds.has(e.kind)) continue;
    const [from, to] =
      direction === "forward" ? [e.source, e.target] : [e.target, e.source];
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }
  return adj;
}

/** Breadth-first search; cycle-safe because each node is visited once. */
function bfs(adj: Adjacency, start: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of start) {
    for (const next of adj.get(s) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  // Array iteration visits items pushed during the loop, so this drains the queue.
  for (const current of queue) {
    for (const next of adj.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Nodes that transitively depend on `nodeId` (the basis of blast radius).
 * The start node is included only if it depends on itself through a cycle.
 */
export function reverseReachable(
  g: Graph,
  nodeId: string,
  kinds: ReadonlySet<EdgeKind>,
): Set<string> {
  return bfs(adjacency(g, kinds, "reverse"), [nodeId]);
}

/**
 * Nodes that the `from` nodes transitively depend on (the basis of
 * reachability for findings). Start nodes are included only if reached
 * through an edge.
 */
export function reachable(
  g: Graph,
  from: readonly string[],
  kinds: ReadonlySet<EdgeKind>,
): Set<string> {
  return bfs(adjacency(g, kinds, "forward"), from);
}
