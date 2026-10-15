import {
  atLeast,
  byConfidence,
  type Confidence,
  type Finding,
  type FindingKind,
  type Graph,
} from "@epoch-dev/core";
import { packageFolders } from "../graph/packages";

/*
 * Pure helpers behind the findings UI: which graph nodes a finding touches,
 * how much code it concerns, the review order, and what the banner counts.
 */

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

const indexes = new WeakMap<
  Graph,
  { ids: ReadonlySet<string>; packageAt: ReadonlyMap<string, string> }
>();

function indexOf(graph: Graph) {
  let ix = indexes.get(graph);
  if (!ix) {
    const packageAt = new Map<string, string>();
    for (const [pkg, folder] of packageFolders(graph))
      packageAt.set(folder, pkg);
    ix = { ids: new Set(graph.nodes.map((n) => n.id)), packageAt };
    indexes.set(graph, ix);
  }
  return ix;
}

/** The graph nodes a finding touches: its files, or the Go packages holding them. */
export function findingNodes(graph: Graph, f: Finding): string[] {
  const { ids, packageAt } = indexOf(graph);
  const out = new Set<string>();
  for (const { file } of f.locations) {
    if (ids.has(file)) out.add(file);
    else {
      const pkg = packageAt.get(dirOf(file));
      if (pkg !== undefined) out.add(pkg);
    }
  }
  return [...out];
}

/** Roughly how much code acting on the finding would touch: lines, usages or file size. */
export function removableSize(graph: Graph, f: Finding): number {
  switch (f.kind) {
    case "dead-branch":
      return f.locations.reduce(
        (n, l) =>
          n + Math.max(1, (l.endLine ?? l.line ?? 0) - (l.line ?? 0) + 1),
        0,
      );
    case "stale-flag":
      return f.locations.length;
    case "unreachable-file": {
      const loc = new Map(graph.nodes.map((n) => [n.id, n.loc]));
      return findingNodes(graph, f).reduce(
        (n, id) => n + (loc.get(id) ?? 0),
        0,
      );
    }
  }
}

/** Review order: higher confidence first, then the larger change, then by name. */
export function sortFindings(
  graph: Graph,
  findings: readonly Finding[],
): Finding[] {
  const size = new Map(findings.map((f) => [f.id, removableSize(graph, f)]));
  return [...findings].sort(
    (a, b) =>
      byConfidence(a.confidence, b.confidence) ||
      (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0) ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.subject.name < b.subject.name
        ? -1
        : a.subject.name > b.subject.name
          ? 1
          : 0),
  );
}

export interface FindingsSummary {
  readonly total: number;
  readonly byKind: Readonly<Record<FindingKind, number>>;
}

/** Open (not dismissed) findings at or above `min`, by kind: what the banner shows. */
export function summarize(
  findings: readonly Finding[],
  open: ReadonlySet<string>,
  min: Confidence,
): FindingsSummary {
  const byKind: Record<FindingKind, number> = {
    "dead-branch": 0,
    "stale-flag": 0,
    "unreachable-file": 0,
  };
  let total = 0;
  for (const f of findings) {
    if (!open.has(f.id) || !atLeast(f.confidence, min)) continue;
    byKind[f.kind]++;
    total++;
  }
  return { total, byKind };
}

/** Node id -> the highest confidence among the open findings touching it. */
export function nodeRings(
  graph: Graph,
  findings: readonly Finding[],
  open: ReadonlySet<string>,
): Map<string, Confidence> {
  const rings = new Map<string, Confidence>();
  for (const f of findings) {
    if (!open.has(f.id)) continue;
    for (const id of findingNodes(graph, f)) {
      const had = rings.get(id);
      if (had === undefined || atLeast(f.confidence, had))
        rings.set(id, f.confidence);
    }
  }
  return rings;
}
