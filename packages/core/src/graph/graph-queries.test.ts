import { describe, expect, it } from "vitest";
import type {
  EdgeKind,
  Finding,
  Graph,
  GraphNode,
  RiskTier,
} from "../schemas/index.js";
import { changeImpact } from "./impact.js";
import { clusters } from "./clusters.js";
import { dependencyPath, mostDependedOn } from "./path.js";

/**
 * Builds a graph from "a>b kind@confidence" edge specs (kind defaults to
 * import, confidence to 1) and bare "a" node specs; nodes are inferred. A
 * "pkg:" id is a Go package node.
 */
function graph(...specs: string[]): Graph {
  const ids = new Set<string>();
  const edges = specs.flatMap((spec) => {
    const [pair = "", rest = "import"] = spec.split(" ");
    const [source = "", target] = pair.split(">");
    ids.add(source);
    if (target === undefined) return [];
    ids.add(target);
    const [kind = "import", conf = "1"] = rest.split("@");
    return [
      {
        source,
        target,
        kind: kind as EdgeKind,
        provenance:
          Number(conf) < 1 ? ("git-cochange" as const) : ("resolver" as const),
        confidence: Number(conf),
        evidence: [`${source} uses ${target}`],
      },
    ];
  });
  const node = (id: string): GraphNode => ({
    id,
    kind: id.startsWith("pkg:") ? "package" : "file",
    language: id.startsWith("pkg:") ? "go" : "typescript",
    loc: 1,
    contentHash: id,
    exports: [],
    externals: [],
    flags: [],
    metrics: { fanIn: 0, fanOut: 0 },
  });
  return {
    schemaVersion: 1,
    nodes: [...ids].sort().map(node),
    edges,
    roots: [],
    findings: [],
    unresolved: [],
  };
}

const withMetrics = (
  g: Graph,
  metrics: Record<
    string,
    { tier?: RiskTier; dependents?: number; churn90d?: number }
  >,
): Graph => ({
  ...g,
  nodes: g.nodes.map((n) => {
    const m = metrics[n.id];
    if (!m) return n;
    return {
      ...n,
      metrics: {
        ...n.metrics,
        ...(m.dependents === undefined ? {} : { dependents: m.dependents }),
        ...(m.churn90d === undefined ? {} : { churn90d: m.churn90d }),
        ...(m.tier === undefined
          ? {}
          : { risk: { tier: m.tier, archetype: "stable-leaf" as const } }),
      },
    };
  }),
});

const certain = { mode: "certain", includeTypeOnly: true } as const;
const likely = {
  mode: "likely",
  includeTypeOnly: true,
  hintThreshold: 0.5,
} as const;

describe("dependencyPath", () => {
  it("finds the shortest chain, with each hop's edge", () => {
    const g = graph("a>b", "b>c", "c>d", "a>x", "x>d");
    const p = dependencyPath(g, "a", "d", certain);
    expect(p?.nodes).toEqual(["a", "x", "d"]);
    expect(p?.hops).toEqual([
      {
        source: "a",
        target: "x",
        kind: "import",
        evidence: ["a uses x"],
        hint: false,
        confidence: 1,
      },
      {
        source: "x",
        target: "d",
        kind: "import",
        evidence: ["x uses d"],
        hint: false,
        confidence: 1,
      },
    ]);
    expect(p?.viaHints).toBe(0);
  });

  it("follows the direction of dependence only", () => {
    const g = graph("a>b", "b>c");
    expect(dependencyPath(g, "c", "a", certain)).toBeNull();
    expect(dependencyPath(g, "a", "c", certain)?.nodes).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("breaks ties by node id, whatever the edge order", () => {
    const one = graph("a>m", "a>k", "k>z", "m>z");
    const two = graph("m>z", "k>z", "a>k", "a>m");
    expect(dependencyPath(one, "a", "z", certain)?.nodes).toEqual([
      "a",
      "k",
      "z",
    ]);
    expect(dependencyPath(two, "a", "z", certain)?.nodes).toEqual([
      "a",
      "k",
      "z",
    ]);
  });

  it("is a single node for a node and itself, and survives cycles", () => {
    const g = graph("a>b", "b>a", "b>c");
    expect(dependencyPath(g, "a", "a", certain)).toEqual({
      from: "a",
      to: "a",
      nodes: ["a"],
      hops: [],
      viaHints: 0,
    });
    expect(dependencyPath(g, "a", "c", certain)?.nodes).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("skips via-barrel edges, and type-only edges when asked to", () => {
    const g = graph("a>b via-barrel", "a>c type-only", "c>b");
    expect(dependencyPath(g, "a", "b", certain)?.nodes).toEqual([
      "a",
      "c",
      "b",
    ]);
    expect(
      dependencyPath(g, "a", "b", { mode: "certain", includeTypeOnly: false }),
    ).toBeNull();
  });

  it("prefers the real import between two nodes over a type-only one", () => {
    const g = graph("a>b type-only", "a>b");
    expect(dependencyPath(g, "a", "b", certain)?.hops[0]?.kind).toBe("import");
  });

  it("uses hints only in likely mode, and only when no chain of facts exists", () => {
    const g = graph(
      "a>b",
      "b>c",
      "c>d",
      "a>d cochange@0.9",
      "a>z cochange@0.6",
    );
    // A proven chain exists, so the shorter hinted one is not given.
    expect(dependencyPath(g, "a", "d", likely)?.nodes).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(dependencyPath(g, "a", "z", certain)).toBeNull();
    const hinted = dependencyPath(g, "a", "z", likely);
    expect(hinted?.nodes).toEqual(["a", "z"]);
    expect(hinted?.hops[0]).toMatchObject({ hint: true, confidence: 0.6 });
    expect(hinted?.viaHints).toBe(1);
    expect(
      dependencyPath(g, "a", "z", { ...likely, hintThreshold: 0.7 }),
    ).toBeNull();
  });

  it("refuses an unknown node and a likely mode with no threshold", () => {
    const g = graph("a>b");
    expect(() => dependencyPath(g, "a", "nope", certain)).toThrow(
      "No node nope in the graph.",
    );
    expect(() =>
      dependencyPath(g, "a", "b", { mode: "likely", includeTypeOnly: true }),
    ).toThrow("Likely mode needs a hint threshold.");
  });
});

describe("mostDependedOn", () => {
  it("orders by transitive dependents, then direct importers, then id", () => {
    const g = withMetrics(graph("a", "b", "c", "d"), {
      a: { dependents: 3 },
      b: { dependents: 7 },
      c: { dependents: 7 },
      d: { dependents: 0 },
    });
    const c = g.nodes.find((n) => n.id === "c");
    if (c) c.metrics.fanIn = 2;
    expect(mostDependedOn(g, 3).map((n) => n.id)).toEqual(["c", "b", "a"]);
    // Nothing depends on d, so it is never listed.
    expect(mostDependedOn(g, 10).map((n) => n.id)).toEqual(["c", "b", "a"]);
  });
});

describe("changeImpact", () => {
  const finding = (id: string, file: string): Finding => ({
    id,
    kind: "dead-branch",
    subject: { type: "file", name: file },
    confidence: "high",
    locations: [{ file, line: 3 }],
    evidence: [],
    caveats: [],
    suggestedAction: "",
    caps: [],
  });

  it("combines the blast radius of every changed node, each counted once", () => {
    const g = graph("a>b", "b>c", "x>c", "y>d", "c>e");
    const r = changeImpact(g, ["c", "d"], certain);
    expect(r.changed.map((c) => c.id)).toEqual(["c", "d"]);
    expect(r.affected).toEqual([
      { id: "b", depth: 1, viaHint: false },
      { id: "x", depth: 1, viaHint: false },
      { id: "y", depth: 1, viaHint: false },
      { id: "a", depth: 2, viaHint: false },
    ]);
    expect(r.total).toBe(4);
    expect(r.maxDepth).toBe(2);
    expect(r.byLanguage).toEqual({ typescript: 4 });
    expect(r.byKind).toEqual({ file: 4, package: 0 });
  });

  it("never lists a changed node as affected, even when it depends on another", () => {
    const g = graph("a>b", "b>c");
    const r = changeImpact(g, ["b", "c"], certain);
    expect(r.affected.map((a) => a.id)).toEqual(["a"]);
    expect(r.affected[0]?.depth).toBe(1);
  });

  it("lists changed paths that are not nodes, and maps members to their node", () => {
    const g = graph("pkg:m/api>pkg:m/db", "a>b");
    const r = changeImpact(g, ["db/conn.go", "README.md", "b", "db/pool.go"], {
      ...certain,
      nodeOf: (p) => (p.startsWith("db/") ? "pkg:m/db" : undefined),
    });
    expect(r.changed).toEqual([
      { id: "b", paths: ["b"], findings: [] },
      {
        id: "pkg:m/db",
        paths: ["db/conn.go", "db/pool.go"],
        findings: [],
      },
    ]);
    expect(r.unanalyzed).toEqual(["README.md"]);
    expect(r.affected.map((a) => a.id)).toEqual(["a", "pkg:m/api"]);
    expect(r.byKind).toEqual({ file: 1, package: 1 });
  });

  it("orders changed nodes by risk, and reports the riskiest tier", () => {
    const g = withMetrics(graph("a", "b", "c", "d"), {
      a: { tier: "low", dependents: 9 },
      b: { tier: "critical", dependents: 1 },
      c: { tier: "high", dependents: 2, churn90d: 1 },
      d: { dependents: 50 },
    });
    const r = changeImpact(g, ["a", "b", "c", "d"], certain);
    expect(r.changed.map((c) => c.id)).toEqual(["b", "c", "a", "d"]);
    expect(r.changed[0]).toMatchObject({
      risk: { tier: "critical" },
      dependents: 1,
    });
    expect(r.highestTier).toBe("critical");
    expect(changeImpact(g, ["d"], certain).highestTier).toBeUndefined();
  });

  it("names the candidates located in the changed files", () => {
    const g: Graph = {
      ...graph("a>b", "c"),
      findings: [finding("f1", "b"), finding("f2", "c"), finding("f0", "b")],
    };
    const r = changeImpact(g, ["b"], certain);
    expect(r.changed[0]?.findings).toEqual(["f0", "f1"]);
  });

  it("marks what only hint edges reach, in likely mode", () => {
    const g = graph("a>b", "h>b cochange@0.8");
    expect(changeImpact(g, ["b"], certain).total).toBe(1);
    const r = changeImpact(g, ["b"], likely);
    expect(r.affected).toEqual([
      { id: "a", depth: 1, viaHint: false },
      { id: "h", depth: 1, viaHint: true },
    ]);
    expect(r.viaHints).toBe(1);
  });

  it("is empty for no changes", () => {
    const r = changeImpact(graph("a>b"), [], certain);
    expect(r).toMatchObject({ changed: [], unanalyzed: [], total: 0 });
  });
});

describe("clusters", () => {
  // Two tight groups joined by one edge, and a file nothing touches.
  const two = [
    "a1>a2",
    "a2>a3",
    "a3>a1",
    "a1>a3",
    "b1>b2",
    "b2>b3",
    "b3>b1",
    "b1>b3",
    "b4>b1",
    "a1>b1",
    "alone",
  ];

  it("groups nodes that depend mostly on each other", () => {
    const c = clusters(graph(...two));
    expect(c.clusters.map((k) => k.members)).toEqual([
      ["b1", "b2", "b3", "b4"],
      ["a1", "a2", "a3"],
    ]);
    expect(c.of.get("a2")).toBe(1);
    expect(c.of.get("b4")).toBe(0);
    expect(c.of.has("alone")).toBe(false);
  });

  it("names a cluster after its most depended-on node", () => {
    const g = withMetrics(graph(...two), {
      a3: { dependents: 5 },
      b1: { dependents: 9 },
    });
    expect(clusters(g).clusters.map((k) => k.label)).toEqual(["b1", "a3"]);
  });

  it("gives the same clusters whatever the edge and node order", () => {
    const forward = clusters(graph(...two));
    const g = graph(...[...two].reverse());
    const backward = clusters({ ...g, nodes: [...g.nodes].reverse() });
    expect(backward.clusters).toEqual(forward.clusters);
  });

  it("ignores hint edges and via-barrel edges", () => {
    const c = clusters(
      graph("a>b", "b>a", "c>d", "d>c", "a>c cochange@0.9", "b>d via-barrel"),
    );
    expect(c.clusters.map((k) => k.members)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("has no clusters for a graph with no edges", () => {
    expect(clusters(graph("a", "b")).clusters).toEqual([]);
  });
});
