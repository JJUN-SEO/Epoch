import type { Graph } from "@epoch-dev/core";
import { isHintEdge, isShownEdge, type EdgeDisplay } from "../graph/aggregate";

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

export function graph3dData(graph: Graph, display: EdgeDisplay): Graph3DData {
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
    if (e.source === e.target || !isShownEdge(e, display)) continue;
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

const sameInts = (a: Int32Array, b: Int32Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Whether two drawings would get the same layout: the same files, folders
 * and edges. An update that changes neither (for example, hint edges the
 * view hides) keeps the layout on screen.
 */
export function sameLayoutInput(a: Graph3DData, b: Graph3DData): boolean {
  return (
    a.ids.length === b.ids.length &&
    a.ids.every((id, i) => id === b.ids[i]) &&
    sameInts(a.groups, b.groups) &&
    sameInts(a.links, b.links)
  );
}

/**
 * Starting positions for a changed graph, from the layout of the previous
 * one: each file keeps its place; a new file starts at the center of its
 * placed neighbors, else of its folder's placed files, else the origin.
 * Undefined when no file is shared, so the layout starts fresh.
 */
export function carryPositions(
  before: Graph3DData,
  positions: Float32Array,
  after: Graph3DData,
): Float32Array | undefined {
  const old = new Map(before.ids.map((id, i) => [id, i]));
  const out = new Float32Array(after.ids.length * 3);
  const placed = new Uint8Array(after.ids.length);
  let shared = 0;
  for (const [i, id] of after.ids.entries()) {
    const j = old.get(id);
    if (j === undefined || 3 * j + 2 >= positions.length) continue;
    for (let k = 0; k < 3; k++) out[3 * i + k] = positions[3 * j + k] ?? 0;
    placed[i] = 1;
    shared++;
  }
  if (shared === 0) return undefined;

  const neighbors = after.ids.map((): number[] => []);
  for (let e = 0; e < after.links.length / 2; e++) {
    const s = after.links[2 * e] ?? 0;
    const t = after.links[2 * e + 1] ?? 0;
    neighbors[s]?.push(t);
    neighbors[t]?.push(s);
  }
  const folders = new Map<number, number[]>();
  for (const [i, g] of after.groups.entries()) {
    if (placed[i] !== 1) continue;
    const list = folders.get(g);
    if (list) list.push(i);
    else folders.set(g, [i]);
  }
  const center = (of: readonly number[], i: number): boolean => {
    const known = of.filter((n) => placed[n] === 1);
    if (known.length === 0) return false;
    for (let k = 0; k < 3; k++) {
      let sum = 0;
      for (const n of known) sum += out[3 * n + k] ?? 0;
      out[3 * i + k] = sum / known.length;
    }
    return true;
  };
  for (let i = 0; i < after.ids.length; i++) {
    if (placed[i] === 1) continue;
    if (!center(neighbors[i] ?? [], i))
      center(folders.get(after.groups[i] ?? -1) ?? [], i);
  }
  return out;
}
