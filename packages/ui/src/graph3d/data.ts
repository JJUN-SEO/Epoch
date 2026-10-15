import type { Graph } from "@epoch-dev/core";
import { isHintEdge, isShownEdge } from "../graph/aggregate";

/*
 * What the 3D overview draws: every file (no folder boxes; folders show as
 * clusters and colors), and the edges the 2D graph draws, merged per pair.
 * Indexed arrays, because the layout worker and the GPU want flat data.
 * Pure, for the tests.
 */

export interface Graph3DData {
  /** Graph node ids, sorted. A node's index is its position here. */
  readonly ids: readonly string[];
  readonly languages: readonly string[];
  readonly fanIn: readonly number[];
  /** Folder index of each node (its parent folder), for clustering. */
  readonly groups: Int32Array;
  /** Edge endpoints as node indices: [source0, target0, source1, target1, ...]. */
  readonly links: Int32Array;
  /** Per edge: an inferred relation (drawn fainter), not a fact. */
  readonly hints: readonly boolean[];
}

const folderOf = (id: string): string =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";

export function graph3dData(graph: Graph, showViaBarrel: boolean): Graph3DData {
  const nodes = [...graph.nodes].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const folders = new Map<string, number>();
  const groups = new Int32Array(nodes.length);
  for (const [i, n] of nodes.entries()) {
    const folder = folderOf(n.id);
    let g = folders.get(folder);
    if (g === undefined) {
      g = folders.size;
      folders.set(folder, g);
    }
    groups[i] = g;
  }

  const pairs = new Map<string, { s: number; t: number; hint: boolean }>();
  for (const e of graph.edges) {
    if (e.source === e.target || !isShownEdge(e, showViaBarrel)) continue;
    const s = index.get(e.source);
    const t = index.get(e.target);
    if (s === undefined || t === undefined) continue;
    const key = `${String(s)}>${String(t)}`;
    const hint = isHintEdge(e);
    const seen = pairs.get(key);
    // A pair with any fact edge is drawn as a fact.
    if (seen) seen.hint &&= hint;
    else pairs.set(key, { s, t, hint });
  }
  const edges = [...pairs.values()].sort((a, b) => a.s - b.s || a.t - b.t);
  const links = new Int32Array(edges.length * 2);
  for (const [i, e] of edges.entries()) {
    links[2 * i] = e.s;
    links[2 * i + 1] = e.t;
  }
  return {
    ids: nodes.map((n) => n.id),
    languages: nodes.map((n) => n.language),
    fanIn: nodes.map((n) => n.metrics.fanIn),
    groups,
    links,
    hints: edges.map((e) => e.hint),
  };
}

/** For each node, the indices of its outgoing and incoming edges. */
export function edgesByNode(data: Graph3DData): {
  readonly out: readonly number[][];
  readonly into: readonly number[][];
} {
  const out = data.ids.map((): number[] => []);
  const into = data.ids.map((): number[] => []);
  for (let e = 0; e < data.hints.length; e++) {
    out[data.links[2 * e] ?? 0]?.push(e);
    into[data.links[2 * e + 1] ?? 0]?.push(e);
  }
  return { out, into };
}
