import type {
  BlastRadiusOptions,
  BlastRadiusResult,
} from "../interfaces/api.js";
import {
  CERTAIN_EDGE_KINDS,
  CERTAIN_EDGE_KINDS_WITHOUT_TYPES,
  HINT_EDGE_KINDS,
  isHintEdge,
} from "../policy.js";
import type { Graph, GraphEdge } from "../schemas/index.js";

type Reverse = ReadonlyMap<string, readonly string[]>;

/** Dependents of each node over the edges `follow` accepts. */
function reverseAdjacency(
  graph: Graph,
  follow: (e: GraphEdge) => boolean,
): Reverse {
  const rev = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.source === e.target || !follow(e)) continue;
    const list = rev.get(e.target);
    if (list) list.push(e.source);
    else rev.set(e.target, [e.source]);
  }
  return rev;
}

/** Breadth-first depth of every node that transitively depends on `start`. */
function depths(
  rev: Reverse,
  start: string,
  maxDepth: number,
): Map<string, number> {
  const depth = new Map<string, number>([[start, 0]]);
  let frontier = [start];
  for (let d = 1; d <= maxDepth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const dependent of rev.get(node) ?? []) {
        if (depth.has(dependent)) continue;
        depth.set(dependent, d);
        next.push(dependent);
      }
    }
    frontier = next;
  }
  depth.delete(start);
  return depth;
}

/** The directory a node counts under: a file's folder, or a package's own path. */
function directoryOf(id: string, kind: "file" | "package"): string {
  if (kind === "package") return id.startsWith("pkg:") ? id.slice(4) : id;
  const slash = id.lastIndexOf("/");
  return slash === -1 ? "." : id.slice(0, slash);
}

const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * The nodes that transitively depend on `nodeId` (CLAUDE.md "Blast radius"):
 * a reverse breadth-first search over the edge kinds of the traversal
 * policy, cycle-safe. Certain mode follows fact edges; likely mode adds hint
 * edges at or above the threshold and marks what only they reach. Pure, so
 * the analysis host, the CLI, the app's renderer and the static demo share it.
 */
export function blastRadius(
  graph: Graph,
  nodeId: string,
  opts: BlastRadiusOptions,
): BlastRadiusResult {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  if (!nodes.has(nodeId)) throw new Error(`No node ${nodeId} in the graph.`);
  const kinds = opts.includeTypeOnly
    ? CERTAIN_EDGE_KINDS
    : CERTAIN_EDGE_KINDS_WITHOUT_TYPES;
  const fact = (e: GraphEdge) => !isHintEdge(e) && kinds.has(e.kind);
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;

  const certain = depths(reverseAdjacency(graph, fact), nodeId, maxDepth);
  let reached = certain;
  if (opts.mode === "likely") {
    const threshold = opts.hintThreshold;
    if (threshold === undefined) {
      throw new Error("Likely mode needs a hint threshold.");
    }
    const hint = (e: GraphEdge) =>
      isHintEdge(e) &&
      e.confidence >= threshold &&
      (HINT_EDGE_KINDS.has(e.kind) || kinds.has(e.kind));
    reached = depths(
      reverseAdjacency(graph, (e) => fact(e) || hint(e)),
      nodeId,
      maxDepth,
    );
  }

  const affected = [...reached.entries()]
    .map(([id, depth]) => ({ id, depth, viaHint: !certain.has(id) }))
    .sort(
      (a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const byDirectory: Record<string, number> = {};
  const byLanguage: Record<string, number> = {};
  const byKind = { file: 0, package: 0 };
  for (const a of affected) {
    const node = nodes.get(a.id);
    if (!node) continue;
    increment(byDirectory, directoryOf(node.id, node.kind));
    increment(byLanguage, node.language);
    byKind[node.kind]++;
  }
  return {
    nodeId,
    affected,
    total: affected.length,
    maxDepth: affected.reduce((m, a) => Math.max(m, a.depth), 0),
    byDirectory,
    byLanguage,
    byKind,
    viaHints: affected.filter((a) => a.viaHint).length,
  };
}
