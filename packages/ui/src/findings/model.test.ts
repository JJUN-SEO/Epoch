import { describe, expect, it } from "vitest";
import {
  PACKAGE_DIRECTORY_EVIDENCE,
  type Finding,
  type Graph,
} from "@epoch-dev/core";
import { edge, graph as testGraph, node } from "../graph/test-graph";
import {
  findingNodes,
  nodeRings,
  removableSize,
  sortFindings,
  summarize,
} from "./model";

const finding = (
  id: string,
  extra: Partial<Finding> & Pick<Finding, "kind" | "confidence" | "locations">,
): Finding => ({
  id,
  subject: { type: "file", name: extra.locations[0]?.file ?? id },
  evidence: ["e"],
  caveats: ["c"],
  suggestedAction: "This looks unused; it may be safe to remove.",
  caps: [],
  ...extra,
});

const g: Graph = {
  ...testGraph([
    "src/a.ts",
    "src/b.ts",
    "internal/x/x_test.go",
    "pkg:example.com/m/internal/x",
  ]),
  nodes: [
    { ...node("src/a.ts"), loc: 10 },
    { ...node("src/b.ts"), loc: 40 },
    node("internal/x/x_test.go", "go"),
    { ...node("pkg:example.com/m/internal/x", "go"), loc: 7 },
  ],
  edges: [
    {
      ...edge("internal/x/x_test.go", "pkg:example.com/m/internal/x"),
      evidence: [PACKAGE_DIRECTORY_EVIDENCE],
    },
  ],
};

const deadA = finding("1", {
  kind: "dead-branch",
  confidence: "high",
  locations: [{ file: "src/a.ts", line: 3, endLine: 9 }],
});
const flag = finding("2", {
  kind: "stale-flag",
  confidence: "medium",
  subject: { type: "flag", name: "beta" },
  locations: [
    { file: "src/a.ts", line: 1, endLine: 1 },
    { file: "src/b.ts", line: 2, endLine: 2 },
  ],
});
const unusedB = finding("3", {
  kind: "unreachable-file",
  confidence: "high",
  locations: [{ file: "src/b.ts" }],
});
const goPkg = finding("4", {
  kind: "unreachable-file",
  confidence: "low",
  locations: [{ file: "internal/x/a.go" }, { file: "internal/x/b.go" }],
});

describe("findings model", () => {
  it("maps findings to graph nodes, Go files to their package", () => {
    expect(findingNodes(g, flag)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(findingNodes(g, goPkg)).toEqual(["pkg:example.com/m/internal/x"]);
  });

  it("sizes a finding by lines, usages or file size", () => {
    expect(removableSize(g, deadA)).toBe(7);
    expect(removableSize(g, flag)).toBe(2);
    expect(removableSize(g, unusedB)).toBe(40);
    expect(removableSize(g, goPkg)).toBe(7);
  });

  it("orders by confidence, then by size", () => {
    expect(
      sortFindings(g, [goPkg, flag, deadA, unusedB]).map((f) => f.id),
    ).toEqual(["3", "1", "2", "4"]);
  });

  it("counts open findings at or above the level, by kind", () => {
    const all = [deadA, flag, unusedB, goPkg];
    const open = new Set(["1", "2", "4"]); // 3 is dismissed
    expect(summarize(all, open, "medium")).toEqual({
      total: 2,
      byKind: { "dead-branch": 1, "stale-flag": 1, "unreachable-file": 0 },
    });
    expect(summarize(all, open, "low").total).toBe(3);
  });

  it("rings each node with the highest open confidence touching it", () => {
    const rings = nodeRings(
      g,
      [deadA, flag, unusedB, goPkg],
      new Set(["2", "3", "4"]),
    );
    expect(Object.fromEntries(rings)).toEqual({
      "src/a.ts": "medium",
      "src/b.ts": "high",
      "pkg:example.com/m/internal/x": "low",
    });
  });
});
