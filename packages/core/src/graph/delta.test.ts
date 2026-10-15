import { describe, expect, it } from "vitest";
import { canonicalizeGraph } from "../canonical.js";
import type { EdgeKind, Graph, GraphNode } from "../schemas/index.js";
import { applyDelta, diffGraphs, isEmptyDelta } from "./delta.js";

/** A small seeded generator, so a failure always reproduces. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const KINDS: EdgeKind[] = ["import", "type-only", "reexport", "via-barrel"];

/** A random graph over a pool of ids, so pairs share some nodes and edges. */
function randomGraph(next: () => number): Graph {
  const pick = <T>(xs: readonly T[]): T =>
    xs[Math.floor(next() * xs.length)] as T;
  const pool = Array.from({ length: 8 }, (_, i) => `src/m${String(i)}.ts`);
  const ids = pool.filter(() => next() < 0.7);
  const nodes: GraphNode[] = ids.map((id) => ({
    id,
    kind: "file",
    language: "typescript",
    loc: Math.floor(next() * 3),
    contentHash: pick(["h1", "h2"]),
    exports: next() < 0.5 ? ["a"] : [],
    externals: [],
    flags: [],
    metrics: { fanIn: Math.floor(next() * 2), fanOut: 0 },
  }));
  const edges = [];
  for (const source of ids) {
    for (const target of ids) {
      if (source === target || next() > 0.3) continue;
      edges.push({
        source,
        target,
        kind: pick(KINDS),
        provenance: "resolver" as const,
        confidence: 1,
        evidence: next() < 0.5 ? [] : ["via barrel src/index.ts"],
      });
    }
  }
  const unresolved =
    ids.length > 0 && next() < 0.5
      ? [
          {
            from: ids[0] ?? "",
            specifier: "./gone",
            reason: "not-found" as const,
            line: 1,
          },
        ]
      : [];
  return canonicalizeGraph({
    schemaVersion: 1,
    nodes,
    edges,
    roots: [],
    findings: [],
    unresolved,
  });
}

describe("diffGraphs and applyDelta", () => {
  it("turn any graph into any other (seeded property test)", () => {
    const next = random(20261015);
    for (let i = 0; i < 300; i++) {
      const a = randomGraph(next);
      const b = randomGraph(next);
      expect(applyDelta(a, diffGraphs(a, b))).toEqual(b);
      expect(isEmptyDelta(diffGraphs(a, a))).toBe(true);
    }
  });

  it("names only what changed", () => {
    const a = randomGraph(random(1));
    const [first] = a.nodes;
    if (!first) throw new Error("fixture has no nodes");
    const b = canonicalizeGraph({
      ...a,
      nodes: a.nodes.map((n) =>
        n.id === first.id ? { ...n, loc: n.loc + 10 } : n,
      ),
    });
    const d = diffGraphs(a, b);
    expect(d.upsertNodes.map((n) => n.id)).toEqual([first.id]);
    expect(d.removeNodes).toEqual([]);
    expect(d.upsertEdges).toEqual([]);
    expect(d.removeEdges).toEqual([]);
    expect(d.unresolved).toBeUndefined();
  });
});
