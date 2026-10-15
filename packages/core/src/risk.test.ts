import { describe, expect, it } from "vitest";
import { percentileRanks, riskBreakdowns, withRiskScores } from "./risk.js";
import type { Graph, GraphNode } from "./schemas/index.js";

const node = (
  id: string,
  metrics: GraphNode["metrics"],
  language = "typescript",
): GraphNode => ({
  id,
  kind: "file",
  language,
  loc: 1,
  contentHash: id,
  exports: [],
  externals: [],
  flags: [],
  metrics,
});

const graph = (nodes: GraphNode[]): Graph => ({
  schemaVersion: 1,
  nodes,
  edges: [],
  roots: [],
  findings: [],
  unresolved: [],
});

describe("percentileRanks", () => {
  it("ranks with ties at their mean rank, independent of order", () => {
    const r = percentileRanks(
      new Map([
        ["a", 0],
        ["b", 1],
        ["c", 1],
        ["d", 3],
      ]),
    );
    expect(Object.fromEntries(r)).toEqual({
      a: 0.125,
      b: 0.5,
      c: 0.5,
      d: 0.875,
    });
    expect(percentileRanks(new Map([["only", 7]])).get("only")).toBe(0.5);
  });
});

describe("riskBreakdowns (hand-computed)", () => {
  // fanIn 0,1,1,3 -> 0.125, 0.5, 0.5, 0.875
  // churn 5,0,2,2 -> 0.875, 0.125, 0.5, 0.5
  // coverage among A, B, D: 0.9, 0.5, 0.1 -> 5/6, 1/2, 1/6 (C has none)
  const g = graph([
    node("A", { fanIn: 0, fanOut: 0, churn90d: 5, coverage: 0.9 }),
    node("B", { fanIn: 1, fanOut: 0, churn90d: 0, coverage: 0.5 }),
    node("C", { fanIn: 1, fanOut: 0, churn90d: 2 }),
    node("D", { fanIn: 3, fanOut: 0, churn90d: 2, coverage: 0.1 }),
    node("data.json", { fanIn: 4, fanOut: 0, churn90d: 1 }, "json"),
  ]);
  const r = riskBreakdowns(g);

  it("applies the full formula where coverage is known", () => {
    // A: 100 * (0.4*0.125 + 0.3*0.875 + 0.3*(1 - 5/6)) = 36.25
    expect(r.get("A")?.score).toBeCloseTo(36.25, 0);
    // B: 100 * (0.4*0.5 + 0.3*0.125 + 0.3*0.5) = 38.75
    expect(r.get("B")?.score).toBeCloseTo(38.75, 0);
    // D: 100 * (0.4*0.875 + 0.3*0.5 + 0.3*(1 - 1/6)) = 75
    expect(r.get("D")?.score).toBe(75);
  });

  it("reweights to 0.55 fan-in + 0.45 churn without coverage", () => {
    // C: 100 * (0.55*0.5 + 0.45*0.5) = 50
    expect(r.get("C")).toMatchObject({ score: 50, missing: ["coverage"] });
    expect(r.get("C")?.components.map((c) => [c.input, c.weight])).toEqual([
      ["fanIn", 0.55],
      ["churn", 0.45],
    ]);
  });

  it("explains every component", () => {
    expect(r.get("D")?.components).toEqual([
      { input: "fanIn", value: 3, percentile: 0.875, weight: 0.4 },
      { input: "churn", value: 2, percentile: 0.5, weight: 0.3 },
      { input: "coverage", value: 0.1, percentile: 1 / 6, weight: 0.3 },
    ]);
  });

  it("scores source files only, not imported assets", () => {
    expect(r.has("data.json")).toBe(false);
  });

  it("gives no score without churn (no git history)", () => {
    const noGit = graph([
      node("a", { fanIn: 2, fanOut: 0, coverage: 0.5 }),
      node("b", { fanIn: 0, fanOut: 0 }),
    ]);
    expect(riskBreakdowns(noGit).size).toBe(0);
    expect(withRiskScores(noGit).nodes.map((n) => n.metrics.riskScore)).toEqual(
      [undefined, undefined],
    );
  });

  it("writes the scores into the graph's metrics", () => {
    const scored = withRiskScores(g);
    expect(scored.nodes.find((n) => n.id === "D")?.metrics.riskScore).toBe(75);
    expect(
      scored.nodes.find((n) => n.id === "data.json")?.metrics.riskScore,
    ).toBeUndefined();
  });
});
