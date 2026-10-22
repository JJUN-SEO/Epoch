import {
  Graph,
  type EntryPoint,
  type Finding,
  type FlagUsage,
  type GraphEdge,
  type GraphNode,
  type UnresolvedImport,
} from "./schemas/index.js";

/**
 * Orders strings by UTF-16 code units, like Array.prototype.sort's default.
 * Never use localeCompare for canonical output: it depends on ICU and locale,
 * and the same graph must serialize identically on every machine.
 */
export function compareCodeUnits(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares tuples element by element; numbers numerically, strings by code units. */
function compareTuples(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return compareCodeUnits(String(x), String(y));
  }
  return a.length - b.length;
}

function sortBy<T>(
  items: readonly T[],
  key: (item: T) => (string | number)[],
): T[] {
  return [...items].sort((a, b) => compareTuples(key(a), key(b)));
}

const sortedStrings = (items: readonly string[]): string[] =>
  [...items].sort(compareCodeUnits);

const flagKey = (f: FlagUsage): (string | number)[] => [
  f.line,
  f.endLine,
  f.flagName ?? "",
  f.detection,
];

function canonicalNode(n: GraphNode): GraphNode {
  return {
    ...n,
    exports: sortedStrings(n.exports),
    externals: sortedStrings(n.externals),
    flags: sortBy(n.flags, flagKey),
  };
}

function canonicalEdge(e: GraphEdge): GraphEdge {
  return { ...e, evidence: sortedStrings(e.evidence) };
}

/**
 * Sorts every array the contract orders (CLAUDE.md "Canonical form").
 * Set-like inner arrays (exports, externals, edge evidence) are sorted too.
 * A finding's evidence, caveats and caps keep their order: the rubric writes
 * them in a deliberate, deterministic order for people to read.
 */
export function canonicalizeGraph(g: Graph): Graph {
  return {
    ...g,
    nodes: sortBy(g.nodes.map(canonicalNode), (n) => [n.id]),
    edges: sortBy(g.edges.map(canonicalEdge), (e) => [
      e.source,
      e.target,
      e.kind,
    ]),
    roots: sortBy(g.roots, (r: EntryPoint) => [r.file, r.reason, r.source]),
    findings: sortBy(
      g.findings.map((f) => ({
        ...f,
        locations: sortBy(f.locations, (l) => [
          l.file,
          l.line ?? 0,
          l.endLine ?? 0,
        ]),
      })),
      (f: Finding) => [f.kind, f.subject.name, f.id],
    ),
    unresolved: sortBy(g.unresolved, (u: UnresolvedImport) => [
      u.from,
      u.line,
      u.specifier ?? "",
      u.reason,
    ]),
  };
}

/**
 * The canonical serialization used for tests, benchmarks and the equivalence
 * test: validated against the schema, arrays sorted, keys in schema order,
 * two-space JSON with a trailing newline. Throws if the graph is invalid.
 */
export function serializeCanonical(g: Graph): string {
  return `${JSON.stringify(Graph.parse(canonicalizeGraph(g)), null, 2)}\n`;
}
