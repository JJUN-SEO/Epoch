import { describe, expect, it } from "vitest";
import {
  CERTAIN_EDGE_KINDS,
  CERTAIN_EDGE_KINDS_WITHOUT_TYPES,
  REACHABILITY_EDGE_KINDS,
} from "../policy.js";
import type { EdgeKind, Graph } from "../schemas/index.js";
import { reachable, reverseReachable } from "./reachability.js";
import { stronglyConnectedComponents } from "./scc.js";

/** Builds a graph from "a>b:kind" edge specs; nodes are inferred. */
function graph(...specs: string[]): Graph {
  const ids = new Set<string>();
  const edges = specs.map((spec) => {
    const [pair, kind = "import"] = spec.split(":");
    const [source = "", target = ""] = (pair ?? "").split(">");
    ids.add(source);
    ids.add(target);
    return {
      source,
      target,
      kind: kind as EdgeKind,
      provenance: "resolver" as const,
      confidence: 1,
      evidence: [],
    };
  });
  return {
    schemaVersion: 1,
    nodes: [...ids].map((id) => ({
      id,
      kind: "file" as const,
      language: "typescript",
      loc: 1,
      contentHash: id,
      exports: [],
      externals: [],
      flags: [],
      metrics: { fanIn: 0, fanOut: 0 },
    })),
    edges,
    roots: [],
    findings: [],
    unresolved: [],
  };
}

const sorted = (s: Set<string>): string[] => [...s].sort();

describe("reverseReachable (blast radius basis)", () => {
  it("follows a chain backwards", () => {
    const g = graph("a>b", "b>c", "c>d");
    expect(sorted(reverseReachable(g, "d", CERTAIN_EDGE_KINDS))).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sorted(reverseReachable(g, "a", CERTAIN_EDGE_KINDS))).toEqual([]);
  });

  it("counts each node once in a diamond", () => {
    const g = graph("a>b", "a>c", "b>d", "c>d");
    expect(sorted(reverseReachable(g, "d", CERTAIN_EDGE_KINDS))).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("terminates on cycles and includes the start only through the cycle", () => {
    const g = graph("a>b", "b>c", "c>a", "x>a");
    expect(sorted(reverseReachable(g, "a", CERTAIN_EDGE_KINDS))).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
  });

  it("ignores via-barrel edges in certain mode", () => {
    const g = graph("a>barrel:via-barrel", "a>card:import");
    expect(sorted(reverseReachable(g, "barrel", CERTAIN_EDGE_KINDS))).toEqual(
      [],
    );
    expect(sorted(reverseReachable(g, "card", CERTAIN_EDGE_KINDS))).toEqual([
      "a",
    ]);
  });

  it("honours the type-only toggle", () => {
    const g = graph("a>t:type-only");
    expect(sorted(reverseReachable(g, "t", CERTAIN_EDGE_KINDS))).toEqual(["a"]);
    expect(
      sorted(reverseReachable(g, "t", CERTAIN_EDGE_KINDS_WITHOUT_TYPES)),
    ).toEqual([]);
  });

  it("never follows hint edges in certain mode", () => {
    const g = graph("a>b:cochange");
    expect(sorted(reverseReachable(g, "b", CERTAIN_EDGE_KINDS))).toEqual([]);
  });
});

describe("reachable (findings reachability basis)", () => {
  it("follows every fact kind, including via-barrel and type-only", () => {
    const g = graph(
      "root>barrel:via-barrel",
      "barrel>c:reexport",
      "root>t:type-only",
    );
    expect(sorted(reachable(g, ["root"], REACHABILITY_EDGE_KINDS))).toEqual([
      "barrel",
      "c",
      "t",
    ]);
  });

  it("starts from several roots and handles cycles", () => {
    const g = graph("r1>a", "a>b", "b>a", "r2>c");
    expect(sorted(reachable(g, ["r1", "r2"], REACHABILITY_EDGE_KINDS))).toEqual(
      ["a", "b", "c"],
    );
  });
});

describe("stronglyConnectedComponents (cycles)", () => {
  it("reports multi-node cycles and self-loops, sorted", () => {
    const g = graph("b>a", "a>b", "s>s", "x>y", "z>q", "q>z");
    expect(stronglyConnectedComponents(g, CERTAIN_EDGE_KINDS)).toEqual([
      ["a", "b"],
      ["q", "z"],
      ["s"],
    ]);
  });

  it("reports nothing for an acyclic graph", () => {
    const g = graph("a>b", "a>c", "b>d", "c>d");
    expect(stronglyConnectedComponents(g, CERTAIN_EDGE_KINDS)).toEqual([]);
  });

  it("only counts the requested edge kinds", () => {
    const g = graph("a>b:import", "b>a:via-barrel");
    expect(stronglyConnectedComponents(g, CERTAIN_EDGE_KINDS)).toEqual([]);
    expect(stronglyConnectedComponents(g, REACHABILITY_EDGE_KINDS)).toEqual([
      ["a", "b"],
    ]);
  });
});
