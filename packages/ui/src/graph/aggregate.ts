import {
  DISPLAY_EDGE_KINDS,
  hintSourceLabel,
  isHintEdge,
  type EdgeKind,
  type Graph,
  type GraphEdge,
} from "@epoch-dev/core";

import { packageFolders } from "./packages.js";

export { isHintEdge };

/*
 * What the graph view shows: files inside directory compound nodes, where a
 * collapsed directory stands in for every file beneath it and edges into or
 * out of it are merged (with counts). Pure, so it is unit-tested and the
 * static demo site runs the same code.
 */

/**
 * About this many nodes (files and closed folders) are drawn when a project
 * opens; larger projects start as a map of folders (CLAUDE.md "App UX basics":
 * collapse by directory).
 */
export const INITIAL_NODE_BUDGET = 50;

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
  /** Hints only: what the relation rests on, in words, for the hover text. */
  readonly detail?: string;
}

export interface VisibleGraph {
  readonly nodes: readonly VisibleNode[];
  readonly edges: readonly VisibleEdge[];
}

/** Which edges the graph views draw (CLAUDE.md "Edge traversal policy"). */
export interface EdgeDisplay {
  /** Show via-barrel edges (hidden by default; CLAUDE.md "Edge traversal policy"). */
  readonly showViaBarrel: boolean;
  /**
   * Draw hint edges at or above this confidence. Absent: hints are hidden,
   * as the default display shows fact edges only.
   */
  readonly hintThreshold?: number | undefined;
}

export interface AggregateOptions extends EdgeDisplay {
  /** Directory paths that are open. */
  readonly expanded: ReadonlySet<string>;
}

/**
 * Whether the graph views draw an edge: the default display set of the
 * traversal policy, plus via-barrel edges and hints only when asked for.
 */
export const isShownEdge = (e: GraphEdge, display: EdgeDisplay): boolean =>
  isHintEdge(e)
    ? display.hintThreshold !== undefined &&
      e.confidence >= display.hintThreshold
    : DISPLAY_EDGE_KINDS.has(e.kind) ||
      (e.kind === "via-barrel" && display.showViaBarrel);

/** A hint edge in words: "Likely relation (co-change, 0.80): <evidence>". */
export function hintDetail(e: GraphEdge): string {
  const head = `Likely relation (${hintSourceLabel(e)}, ${e.confidence.toFixed(2)})`;
  return e.evidence.length === 0 ? head : `${head}: ${e.evidence.join("; ")}`;
}

/**
 * The folders above a node: "a/b/c.ts" -> ["a", "a/b"]. A Go package sits in
 * its directory (packageFolders), so "pkg:m/a/b" in folder "a/b" gives
 * ["a", "a/b"]; without the graph, packages have none.
 */
export function ancestors(id: string, graph?: Graph): string[] {
  const pkg = id.startsWith("pkg:");
  const folder = pkg
    ? ((graph ? packageFolders(graph).get(id) : undefined) ?? "")
    : id.includes("/")
      ? id.slice(0, id.lastIndexOf("/"))
      : "";
  if (folder === "") return [];
  const parts = folder.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export const basename = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * The folders open when a project opens: breadth-first, shallow folders
 * first (by path within a level), each opened only while the drawn nodes stay
 * within `budget`. Opening a folder replaces it with its files and subfolders.
 */
export function initialExpanded(
  graph: Graph,
  budget = INITIAL_NODE_BUDGET,
): Set<string> {
  const children = new Map<string, Set<string>>();
  const add = (dir: string, child: string) => {
    const set = children.get(dir);
    if (set) set.add(child);
    else children.set(dir, new Set([child]));
  };
  for (const n of graph.nodes) {
    const dirs = ancestors(n.id, graph);
    add(dirs.at(-1) ?? "", n.id);
    for (const [i, d] of dirs.entries()) add(dirs[i - 1] ?? "", d);
  }
  const subdirs = (dir: string) =>
    [...(children.get(dir) ?? [])].filter((c) => children.has(c)).sort();

  const expanded = new Set<string>();
  let drawn = children.get("")?.size ?? 0;
  const queue = subdirs("");
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const cost = (children.get(next)?.size ?? 0) - 1;
    if (drawn + cost > budget) continue;
    expanded.add(next);
    drawn += cost;
    queue.push(...subdirs(next));
  }
  return expanded;
}

/** `expanded` plus every directory above `id` (a node or a dirId), so it becomes visible. */
export function expandTo(
  expanded: ReadonlySet<string>,
  id: string,
  graph?: Graph,
): Set<string> {
  return new Set([
    ...expanded,
    ...ancestors(isDirId(id) ? dirPath(id) : id, graph),
  ]);
}

/** The visible node a graph node is drawn as: itself, or its outermost collapsed directory. */
export function representative(
  id: string,
  expanded: ReadonlySet<string>,
  graph?: Graph,
): string {
  for (const a of ancestors(id, graph)) {
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
    const dirs = ancestors(n.id, graph);
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
    if (representative(n.id, expanded, graph) === n.id) {
      const parent = dirs.at(-1);
      nodes.set(n.id, {
        id: n.id,
        kind: n.kind,
        label: basename(n.id),
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
      strongest?: GraphEdge;
    }
  >();
  for (const e of graph.edges) {
    if (!isShownEdge(e, options)) continue;
    const hint = isHintEdge(e);
    const source = representative(e.source, expanded, graph);
    const target = representative(e.target, expanded, graph);
    if (source === target) continue;
    const key = `${source}\u0000${target}\u0000${hint ? "h" : "f"}`;
    const m = merged.get(key);
    if (m) {
      m.kinds.add(e.kind);
      m.count++;
      if (hint && e.confidence > (m.strongest?.confidence ?? 0))
        m.strongest = e;
    } else {
      merged.set(key, {
        source,
        target,
        hint,
        kinds: new Set([e.kind]),
        count: 1,
        ...(hint ? { strongest: e } : {}),
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
    ...(m.strongest === undefined
      ? {}
      : {
          detail:
            m.count === 1
              ? hintDetail(m.strongest)
              : `${String(m.count)} likely relations, the strongest ${m.strongest.confidence.toFixed(2)}`,
        }),
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
