import { PACKAGE_DIRECTORY_EVIDENCE, type Graph } from "@epoch-dev/core";

/*
 * Where each Go package node sits in the folder map (ADR-013). A package id
 * is an import path, not a directory, so the directory is learned from the
 * graph: a test file linked to its package (`test file in the package
 * directory`) pairs an import path with its directory, which gives its
 * module's import-path prefix and directory. Packages no test file anchors
 * fall back to dropping the import-path prefix they all share.
 */

const segments = (p: string): string[] => (p === "" ? [] : p.split("/"));
const folderOf = (id: string): string =>
  id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
const join = (a: string, b: string): string =>
  a === "" ? b : b === "" ? a : `${a}/${b}`;
const hasPathPrefix = (s: string, prefix: string): boolean =>
  prefix === "" || s === prefix || s.startsWith(`${prefix}/`);

function commonPrefix(paths: readonly string[]): string {
  const [first, ...rest] = paths.map(segments);
  if (!first) return "";
  let n = first.length;
  for (const p of rest) {
    let i = 0;
    while (i < n && i < p.length && p[i] === first[i]) i++;
    n = i;
  }
  return first.slice(0, n).join("/");
}

const memo = new WeakMap<Graph, ReadonlyMap<string, string>>();

/** Package node id -> repo-relative folder ("" for the root). */
export function packageFolders(graph: Graph): ReadonlyMap<string, string> {
  const cached = memo.get(graph);
  if (cached) return cached;
  // Import-path prefix -> directory, from each test file's link.
  const anchors = new Map<string, string>();
  for (const e of graph.edges) {
    if (!e.target.startsWith("pkg:")) continue;
    if (!e.evidence.includes(PACKAGE_DIRECTORY_EVIDENCE)) continue;
    const imp = segments(e.target.slice(4));
    const dir = segments(folderOf(e.source));
    let k = 0;
    while (
      k < imp.length &&
      k < dir.length &&
      imp[imp.length - 1 - k] === dir[dir.length - 1 - k]
    ) {
      k++;
    }
    const prefix = imp.slice(0, imp.length - k).join("/");
    if (!anchors.has(prefix)) {
      anchors.set(prefix, dir.slice(0, dir.length - k).join("/"));
    }
  }
  const byLength = [...anchors.keys()].sort((a, b) => b.length - a.length);
  const folders = new Map<string, string>();
  const unanchored: string[] = [];
  for (const n of graph.nodes) {
    if (!n.id.startsWith("pkg:")) continue;
    const path = n.id.slice(4);
    const prefix = byLength.find((p) => hasPathPrefix(path, p));
    if (prefix === undefined) {
      unanchored.push(n.id);
      continue;
    }
    const rest = prefix === "" ? path : path.slice(prefix.length + 1);
    folders.set(n.id, join(anchors.get(prefix) ?? "", rest));
  }
  const shared = commonPrefix(unanchored.map((id) => id.slice(4)));
  for (const id of unanchored) {
    const path = id.slice(4);
    folders.set(
      id,
      path === shared
        ? ""
        : path.slice(shared.length + (shared === "" ? 0 : 1)),
    );
  }
  memo.set(graph, folders);
  return folders;
}
