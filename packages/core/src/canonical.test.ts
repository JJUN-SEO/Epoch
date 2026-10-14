import { describe, expect, it } from "vitest";
import {
  canonicalizeGraph,
  compareCodeUnits,
  serializeCanonical,
} from "./canonical.js";
import type { Graph, GraphEdge, GraphNode } from "./schemas/index.js";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  kind: "file",
  language: "typescript",
  loc: 1,
  contentHash: `hash-${id}`,
  exports: [],
  externals: [],
  flags: [],
  metrics: { fanIn: 0, fanOut: 0 },
  ...extra,
});

const edge = (
  source: string,
  target: string,
  kind: GraphEdge["kind"],
  evidence: string[] = [],
): GraphEdge => ({
  source,
  target,
  kind,
  provenance: "resolver",
  confidence: 1,
  evidence,
});

function sample(): Graph {
  return {
    schemaVersion: 1,
    nodes: [
      node("src/b.ts", { exports: ["z", "a"], externals: ["zod", "@scope/x"] }),
      node("src/a.ts"),
      node("src/Z.ts"),
    ],
    edges: [
      edge("src/b.ts", "src/a.ts", "type-only"),
      edge("src/a.ts", "src/b.ts", "via-barrel"),
      edge("src/a.ts", "src/b.ts", "import", ["via barrel y", "via barrel x"]),
    ],
    roots: [
      { file: "src/b.ts", reason: "test", source: "t" },
      { file: "src/a.ts", reason: "manifest", source: "m" },
    ],
    findings: [],
    unresolved: [
      { from: "src/b.ts", specifier: "./x", reason: "not-found", line: 3 },
      { from: "src/a.ts", specifier: "./y", reason: "not-found", line: 9 },
      { from: "src/a.ts", specifier: "./w", reason: "not-found", line: 2 },
    ],
  };
}

/** Deterministic shuffle (no Math.random: reproducible failures). */
function permute<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    const tmp = out[i];
    out[i] = out[j] as T;
    out[j] = tmp as T;
  }
  return out;
}

function shuffled(g: Graph, seed: number): Graph {
  return {
    ...g,
    nodes: permute(g.nodes, seed).map((n) => ({
      ...n,
      exports: permute(n.exports, seed + 1),
      externals: permute(n.externals, seed + 2),
    })),
    edges: permute(g.edges, seed + 3).map((e) => ({
      ...e,
      evidence: permute(e.evidence, seed + 4),
    })),
    roots: permute(g.roots, seed + 5),
    unresolved: permute(g.unresolved, seed + 6),
  };
}

describe("compareCodeUnits", () => {
  it("orders by UTF-16 code units, independent of locale", () => {
    const words = ["b", "a", "B", "é", "Z", "aa", ""];
    expect([...words].sort(compareCodeUnits)).toEqual([
      "",
      "B",
      "Z",
      "a",
      "aa",
      "b",
      "é",
    ]);
  });
});

describe("canonical form", () => {
  it("sorts every array the contract orders", () => {
    const g = canonicalizeGraph(sample());
    expect(g.nodes.map((n) => n.id)).toEqual([
      "src/Z.ts",
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(g.nodes[2]?.exports).toEqual(["a", "z"]);
    expect(g.nodes[2]?.externals).toEqual(["@scope/x", "zod"]);
    expect(g.edges.map((e) => `${e.source}>${e.target}:${e.kind}`)).toEqual([
      "src/a.ts>src/b.ts:import",
      "src/a.ts>src/b.ts:via-barrel",
      "src/b.ts>src/a.ts:type-only",
    ]);
    expect(g.edges[0]?.evidence).toEqual(["via barrel x", "via barrel y"]);
    expect(g.roots.map((r) => r.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(g.unresolved.map((u) => `${u.from}:${String(u.line)}`)).toEqual([
      "src/a.ts:2",
      "src/a.ts:9",
      "src/b.ts:3",
    ]);
  });

  it("serializes shuffled inputs to byte-identical JSON", () => {
    const expected = serializeCanonical(sample());
    for (let seed = 1; seed <= 25; seed++) {
      expect(serializeCanonical(shuffled(sample(), seed))).toBe(expected);
    }
  });

  it("writes keys in schema order with a trailing newline", () => {
    const text = serializeCanonical(sample());
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "schemaVersion",
      "nodes",
      "edges",
      "roots",
      "findings",
      "unresolved",
    ]);
  });

  it("does not mutate its input", () => {
    const g = sample();
    const before = JSON.stringify(g);
    canonicalizeGraph(g);
    expect(JSON.stringify(g)).toBe(before);
  });

  it("rejects graphs that violate the schema", () => {
    const bad = {
      ...sample(),
      edges: [{ ...edge("a", "b", "import"), confidence: 2 }],
    };
    expect(() => serializeCanonical(bad)).toThrow();
  });
});
