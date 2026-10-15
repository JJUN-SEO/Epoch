import {
  DISPLAY_EDGE_KINDS,
  HINT_EDGE_KINDS,
  type EdgeKind,
  type Graph,
  type GraphEdge,
} from "@epoch-dev/core";

/*
 * What the graph view shows: files inside directory compound nodes, where a
 * collapsed directory stands in for every file beneath it and edges into or
 * out of it are merged (with counts). Pure, so it is unit-tested and the
 * static demo site runs the same code.
 */

/** Directories start collapsed above this many file nodes (CLAUDE.md "App UX basics"). */
export const COLLAPSE_ABOVE = 300;

const DIR = "dir:";
export const dirId = (dir: string): string => `${DIR}${dir}`;
export const isDirId = (id: string): boolean => id.startsWith(DIR);
export const dirPath = (id: string): string => id.slice(DIR.length);

export interface VisibleNode {
  /** A graph node id, or dirId(path) for a directory. */
  readonly id: string;
  readonly kind: "file" | "package" | "dir";
  readonly label: string;
  /** The expanded directory that contains it, as a compound parent. */
  readonly parent?: string;
  /** Directories only: shown as one node standing in for its files. */
  readonly collapsed: boolean;
  /** Files at or under this node. */
  readonly fileCount: number;
  readonly language?: string;
}

export interface VisibleEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** Drawn dashed: an inferred relation, not a resolver-proven fact. */
  readonly hint: boolean;
  readonly kinds: readonly EdgeKind[];
  /** Graph edges merged into this one. */
  readonly count: number;
}

export interface VisibleGraph {
  readonly nodes: readonly VisibleNode[];
  readonly edges: readonly VisibleEdge[];
}

export interface AggregateOptions {
  /** Directory paths that are open. */
  readonly expanded: ReadonlySet<string>;
  /** Show via-barrel edges (hidden by default; CLAUDE.md "Edge traversal policy"). */
  readonly showViaBarrel: boolean;
}

/** An inferred relation (drawn dashed), not a resolver-proven fact. */
export const isHintEdge = (e: GraphEdge): boolean =>
  HINT_EDGE_KINDS.has(e.kind) || e.confidence < 1;

/**
 * Whether the graph views draw an edge: the default display set of the
 * traversal policy, hints, and via-barrel edges only when asked for.
 */
export const isShownEdge = (e: GraphEdge, showViaBarrel: boolean): boolean =>
  isHintEdge(e) ||
  DISPLAY_EDGE_KINDS.has(e.kind) ||
  (e.kind === "via-barrel" && showViaBarrel);

/** "a/b/c.ts" -> ["a", "a/b"]; package and root-level nodes have none. */
export function ancestors(id: string): string[] {
  if (id.startsWith("pkg:")) return [];
  const parts = id.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}

export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Every directory of the graph, expanded, unless it has more than COLLAPSE_ABOVE nodes. */
export function initialExpanded(graph: Graph): Set<string> {
  if (graph.nodes.length > COLLAPSE_ABOVE) return new Set();
  return new Set(graph.nodes.flatMap((n) => ancestors(n.id)));
}

/** `expanded` plus every directory above `id` (a node or a dirId), so it becomes visible. */
export function expandTo(
  expanded: ReadonlySet<string>,
  id: string,
): Set<string> {
  return new Set([...expanded, ...ancestors(isDirId(id) ? dirPath(id) : id)]);
}

/** The visible node a graph node is drawn as: itself, or its outermost collapsed directory. */
export function representative(
  id: string,
  expanded: ReadonlySet<string>,
): string {
  for (const a of ancestors(id)) {
    if (!expanded.has(a)) return dirId(a);
  }
  return id;
}

export function aggregate(
  graph: Graph,
  options: AggregateOptions,
): VisibleGraph {
  const { expanded } = options;
  const nodes = new Map<string, VisibleNode>();
  const fileCounts = new Map<string, number>();

  for (const n of graph.nodes) {
    const dirs = ancestors(n.id);
    for (const d of dirs) fileCounts.set(d, (fileCounts.get(d) ?? 0) + 1);
    // Directories along the path, down to the first collapsed one.
    for (const [i, d] of dirs.entries()) {
      const parent = dirs[i - 1];
      if (!nodes.has(dirId(d))) {
        nodes.set(dirId(d), {
          id: dirId(d),
          kind: "dir",
          label: basename(d),
          ...(parent === undefined ? {} : { parent: dirId(parent) }),
          collapsed: !expanded.has(d),
          fileCount: 0,
        });
      }
      if (!expanded.has(d)) break;
    }
    if (representative(n.id, expanded) === n.id) {
      const parent = dirs.at(-1);
      nodes.set(n.id, {
        id: n.id,
        kind: n.kind,
        label: n.kind === "package" ? n.id : basename(n.id),
        ...(parent === undefined ? {} : { parent: dirId(parent) }),
        collapsed: false,
        fileCount: 1,
        language: n.language,
      });
    }
  }
  for (const [id, node] of nodes) {
    if (node.kind === "dir") {
      nodes.set(id, { ...node, fileCount: fileCounts.get(dirPath(id)) ?? 0 });
    }
  }

  const merged = new Map<
    string,
    {
      source: string;
      target: string;
      hint: boolean;
      kinds: Set<EdgeKind>;
      count: number;
    }
  >();
  for (const e of graph.edges) {
    if (!isShownEdge(e, options.showViaBarrel)) continue;
    const hint = isHintEdge(e);
    const source = representative(e.source, expanded);
    const target = representative(e.target, expanded);
    if (source === target) continue;
    const key = `${source}\u0000${target}\u0000${hint ? "h" : "f"}`;
    const m = merged.get(key);
    if (m) {
      m.kinds.add(e.kind);
      m.count++;
    } else {
      merged.set(key, {
        source,
        target,
        hint,
        kinds: new Set([e.kind]),
        count: 1,
      });
    }
  }
  const edges: VisibleEdge[] = [...merged.values()].map((m) => ({
    id: `${m.source}->${m.target}${m.hint ? " (hint)" : ""}`,
    source: m.source,
    target: m.target,
    hint: m.hint,
    kinds: [...m.kinds].sort(),
    count: m.count,
  }));

  return {
    nodes: [...nodes.values()].sort(byId),
    edges: edges.sort(byId),
  };
}

/** Node ids whose path contains `query` (case-insensitive), sorted, at most `limit`. */
export function searchNodes(graph: Graph, query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  return graph.nodes
    .filter((n) => n.id.toLowerCase().includes(q))
    .map((n) => n.id)
    .slice(0, limit);
}
