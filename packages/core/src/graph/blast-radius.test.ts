import { describe, expect, it } from "vitest";
import type { EdgeKind, Graph, GraphNode } from "../schemas/index.js";
import { blastRadius } from "./blast-radius.js";

/**
 * Builds a graph from "a>b kind@confidence" edge specs (kind defaults to
 * import, confidence to 1); nodes are inferred. A "pkg:" id is a Go package
 * node; ".py" files are Python.
 */
function graph(...specs: string[]): Graph {
  const ids = new Set<string>();
  const edges = specs.map((spec) => {
    const [pair = "", rest = "import"] = spec.split(" ");
    const [kind = "import", conf = "1"] = rest.split("@");
    const [source = "", target = ""] = pair.split(">");
    ids.add(source);
    ids.add(target);
    return {
      source,
      target,
      kind: kind as EdgeKind,
      provenance:
        Number(conf) < 1 ? ("git-cochange" as const) : ("resolver" as const),
      confidence: Number(conf),
      evidence: [],
    };
  });
  const node = (id: string): GraphNode => ({
    id,
    kind: id.startsWith("pkg:") ? "package" : "file",
    language: id.endsWith(".py")
      ? "python"
      : id.startsWith("pkg:")
        ? "go"
        : "typescript",
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

const certain = { mode: "certain", includeTypeOnly: true } as const;
const affected = (r: ReturnType<typeof blastRadius>) =>
  r.affected.map((a) => `${a.id}@${String(a.depth)}`);

describe("blastRadius", () => {
  it("follows a chain backwards, with depth and an optional cap", () => {
    const g = graph("a>b", "b>c", "c>d");
    const r = blastRadius(g, "d", certain);
    expect(affected(r)).toEqual(["c@1", "b@2", "a@3"]);
    expect(r.total).toBe(3);
    expect(r.maxDepth).toBe(3);
    expect(affected(blastRadius(g, "d", { ...certain, maxDepth: 2 }))).toEqual([
      "c@1",
      "b@2",
    ]);
    expect(blastRadius(g, "a", certain).total).toBe(0);
  });

  it("counts a diamond's top once, at its shortest depth", () => {
    const g = graph("a>b", "a>c", "b>d", "c>d");
    const r = blastRadius(g, "d", certain);
    expect(affected(r)).toEqual(["b@1", "c@1", "a@2"]);
    expect(r.maxDepth).toBe(2);
  });

  it("is cycle-safe and never lists the changed node itself", () => {
    const g = graph("a>b", "b>a", "c>a");
    expect(affected(blastRadius(g, "a", certain))).toEqual(["b@1", "c@1"]);
  });

  it("follows the barrel transparency rule (CLAUDE.md)", () => {
    // app imports X from barrel index, which re-exports it from core;
    // index also re-exports sibling.
    const g = graph(
      "app.ts>core.ts import",
      "app.ts>index.ts via-barrel",
      "index.ts>core.ts reexport",
      "index.ts>sibling.ts reexport",
    );
    // The real dependency: changing core affects app (and the barrel).
    expect(affected(blastRadius(g, "core.ts", certain))).toEqual([
      "app.ts@1",
      "index.ts@1",
    ]);
    // Changing a sibling the barrel also re-exports does not flag app.
    expect(affected(blastRadius(g, "sibling.ts", certain))).toEqual([
      "index.ts@1",
    ]);
    // via-barrel records the physical path only: not a blast-radius edge.
    expect(blastRadius(g, "index.ts", certain).total).toBe(0);
  });

  it("follows type-only edges only when asked", () => {
    const g = graph("a>b type-only", "c>b import");
    expect(affected(blastRadius(g, "b", certain))).toEqual(["a@1", "c@1"]);
    expect(
      affected(blastRadius(g, "b", { ...certain, includeTypeOnly: false })),
    ).toEqual(["c@1"]);
  });

  it("adds hint edges above the threshold in likely mode, and counts them", () => {
    const g = graph("a>b cochange@0.8", "c>b import", "d>a import");
    expect(affected(blastRadius(g, "b", certain))).toEqual(["c@1"]);
    const likely = blastRadius(g, "b", {
      ...certain,
      mode: "likely",
      hintThreshold: 0.7,
    });
    expect(affected(likely)).toEqual(["a@1", "c@1", "d@2"]);
    expect(likely.affected.map((a) => a.viaHint)).toEqual([true, false, true]);
    expect(likely.viaHints).toBe(2);
    expect(
      blastRadius(g, "b", { ...certain, mode: "likely", hintThreshold: 0.9 })
        .total,
    ).toBe(1);
    expect(() =>
      blastRadius(g, "b", { mode: "likely", includeTypeOnly: true }),
    ).toThrow("threshold");
  });

  it("groups the affected nodes by directory, language and kind", () => {
    const g = graph(
      "src/a.ts>lib/z.ts",
      "src/b.ts>lib/z.ts",
      "tools/c.py>lib/z.ts",
      "pkg:example.com/m/x>lib/z.ts",
      "top.ts>src/a.ts",
    );
    const r = blastRadius(g, "lib/z.ts", certain);
    expect(r.byDirectory).toEqual({
      ".": 1,
      "example.com/m/x": 1,
      src: 2,
      tools: 1,
    });
    expect(r.byLanguage).toEqual({ go: 1, python: 1, typescript: 3 });
    expect(r.byKind).toEqual({ file: 4, package: 1 });
  });

  it("rejects a node the graph does not have", () => {
    expect(() => blastRadius(graph("a>b"), "missing", certain)).toThrow(
      "missing",
    );
  });
});
