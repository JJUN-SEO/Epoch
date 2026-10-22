import { DirectedGraph } from "graphology";
import { stronglyConnectedComponents as graphologySccs } from "graphology-components";
import { compareCodeUnits } from "../canonical.js";
import type { EdgeKind, Graph } from "../schemas/index.js";

/**
 * Dependency cycles: strongly connected components over the given edge kinds
 * that contain more than one node, or a single node with a self-loop.
 * Cycles are derived on demand from edges and are not stored in the Graph
 * (decided in M1 planning), so they can never disagree with the edges.
 * Output is deterministic: members sorted, components sorted by first member.
 */
export function stronglyConnectedComponents(
  g: Graph,
  kinds: ReadonlySet<EdgeKind>,
): string[][] {
  const dg = new DirectedGraph({ allowSelfLoops: true, multi: false });
  const selfLoops = new Set<string>();
  for (const n of g.nodes) dg.mergeNode(n.id);
  for (const e of g.edges) {
    if (!kinds.has(e.kind)) continue;
    dg.mergeNode(e.source);
    dg.mergeNode(e.target);
    dg.mergeEdge(e.source, e.target);
    if (e.source === e.target) selfLoops.add(e.source);
  }
  return graphologySccs(dg)
    .filter((c) => c.length > 1 || selfLoops.has(c[0] ?? ""))
    .map((c) => [...c].sort(compareCodeUnits))
    .sort((a, b) => compareCodeUnits(a[0] ?? "", b[0] ?? ""));
}
