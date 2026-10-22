import { describe, expect, it } from "vitest";
import {
  RISK_DEFAULTS,
  RISK_TIERS,
  assessRisk,
  transitiveDependents,
  withRiskTiers,
  type RiskFacts,
} from "./risk.js";
import type { Graph, GraphEdge, GraphNode } from "./schemas/index.js";

const node = (
  id: string,
  metrics: Partial<GraphNode["metrics"]> = {},
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  kind: "file",
  language: "typescript",
  loc: 1,
  contentHash: id,
  exports: [],
  externals: [],
  flags: [],
  metrics: { fanIn: 0, fanOut: 0, ...metrics },
  ...extra,
});

const edge = (
  source: string,
  target: string,
  kind: GraphEdge["kind"] = "import",
): GraphEdge => ({
  source,
  target,
  kind,
  provenance: kind === "cochange" ? "git-cochange" : "resolver",
  confidence: kind === "cochange" ? 0.9 : 1,
  evidence: [],
});

const graph = (nodes: GraphNode[], edges: GraphEdge[] = []): Graph => ({
  schemaVersion: 2,
  nodes,
  edges,
  roots: [],
  findings: [],
  unresolved: [],
});

/** Facts at the edges of each dimension (RISK_DEFAULTS). */
const EXPOSED = RISK_DEFAULTS.exposedAbove + 1;
const CONTAINED = RISK_DEFAULTS.exposedAbove;
const HOT = RISK_DEFAULTS.hotFrom;
const WARM = RISK_DEFAULTS.hotFrom - 1;
const FRAGILE = RISK_DEFAULTS.fragileAboveLoc + 1;
const STURDY = RISK_DEFAULTS.fragileAboveLoc;

const facts = (
  dependents: number,
  churn90d: number,
  loc: number,
  coverage?: number,
): RiskFacts => ({
  dependents,
  churn90d,
  loc,
  ...(coverage === undefined ? {} : { coverage }),
});

describe("assessRisk: one case per rule (ADR-015)", () => {
  it.each([
    [
      "exposed, hot, fragile",
      facts(EXPOSED, HOT, FRAGILE),
      "critical",
      "volatile-core",
    ],
    [
      "exposed, hot, sturdy",
      facts(EXPOSED, HOT, STURDY),
      "high",
      "active-hotspot",
    ],
    [
      "exposed, warm, fragile",
      facts(EXPOSED, WARM, FRAGILE),
      "high",
      "active-hotspot",
    ],
    [
      "exposed, warm, sturdy",
      facts(EXPOSED, WARM, STURDY),
      "moderate",
      "warm-core",
    ],
    [
      "contained, hot, sturdy",
      facts(CONTAINED, HOT, STURDY),
      "moderate",
      "fragile-leaf",
    ],
    [
      "contained, hot, fragile",
      facts(CONTAINED, HOT, FRAGILE),
      "moderate",
      "fragile-leaf",
    ],
    [
      "contained, warm, fragile",
      facts(CONTAINED, WARM, FRAGILE),
      "moderate",
      "fragile-leaf",
    ],
    [
      "exposed, quiet, sturdy",
      facts(EXPOSED, 0, STURDY),
      "low-moderate",
      "frozen-core",
    ],
    [
      "exposed, quiet, fragile",
      facts(EXPOSED, 0, FRAGILE),
      "low-moderate",
      "frozen-core",
    ],
    [
      "contained, warm, sturdy",
      facts(CONTAINED, WARM, STURDY),
      "low",
      "stable-leaf",
    ],
    [
      "contained, quiet, fragile",
      facts(CONTAINED, 0, FRAGILE),
      "low",
      "stable-leaf",
    ],
    ["contained, quiet, sturdy", facts(0, 0, 1), "low", "stable-leaf"],
  ] as const)("%s", (_name, f, tier, archetype) => {
    expect(assessRisk(f)).toMatchObject({ tier, archetype });
  });

  it("names the dimension each fact fell in", () => {
    expect(assessRisk(facts(EXPOSED, WARM, STURDY))).toEqual({
      tier: "moderate",
      archetype: "warm-core",
      exposure: "exposed",
      change: "warm",
      fragility: "sturdy",
    });
  });

  it("counts low coverage as fragile, whatever the size, and only when known", () => {
    expect(assessRisk(facts(EXPOSED, HOT, 10, 0.49)).tier).toBe("critical");
    expect(assessRisk(facts(EXPOSED, HOT, 10, 0.5)).tier).toBe("high");
    expect(assessRisk(facts(EXPOSED, HOT, 10)).tier).toBe("high");
  });

  it("orders the tiers from most to least risky", () => {
    expect(RISK_TIERS).toEqual([
      "critical",
      "high",
      "moderate",
      "low-moderate",
      "low",
    ]);
  });
});

describe("transitiveDependents", () => {
  it("counts every node that depends on a node through certain edges, cycles included", () => {
    // a -> b -> c, d -> c (type-only), e -> c (cochange hint), c -> b (cycle)
    const g = graph(
      ["a", "b", "c", "d", "e"].map((id) => node(id)),
      [
        edge("a", "b"),
        edge("b", "c"),
        edge("c", "b"),
        edge("d", "c", "type-only"),
        edge("e", "c", "cochange"),
        edge("a", "a"),
      ],
    );
    const deps = transitiveDependents(g);
    expect(deps.get("c")).toBe(3); // b, a, d (not e: a hint)
    expect(deps.get("b")).toBe(3); // a, c, d
    expect(deps.get("a")).toBe(0);
    expect(deps.get("e")).toBe(0);
  });

  it("skips via-barrel edges (the import edge through the barrel carries the dependency)", () => {
    const g = graph(
      [node("app"), node("barrel"), node("impl")],
      [
        edge("app", "impl"),
        edge("barrel", "impl", "reexport"),
        edge("app", "barrel", "via-barrel"),
      ],
    );
    expect(transitiveDependents(g).get("barrel")).toBe(0);
    expect(transitiveDependents(g).get("impl")).toBe(2);
  });
});

describe("withRiskTiers", () => {
  const hub = node("hub", { churn90d: HOT }, { loc: FRAGILE });
  const users = Array.from({ length: EXPOSED }, (_, i) =>
    node(`u${String(i)}`, { churn90d: 0 }),
  );
  const g = graph(
    [hub, ...users, node("data.json", {}, { language: "json" })],
    users.map((u) => edge(u.id, "hub")),
  );

  it("sets dependents on every node and a tier on scored nodes with git history", () => {
    const out = withRiskTiers(g);
    const byId = new Map(out.nodes.map((n) => [n.id, n.metrics]));
    expect(byId.get("hub")).toMatchObject({
      dependents: EXPOSED,
      risk: { tier: "critical", archetype: "volatile-core" },
    });
    expect(byId.get("u0")).toMatchObject({
      dependents: 0,
      risk: { tier: "low", archetype: "stable-leaf" },
    });
    // Not a source language: no tier.
    expect(byId.get("data.json")?.risk).toBeUndefined();
  });

  it("gives no tier without git history, but still counts dependents", () => {
    const noGit = graph(
      [node("hub", {}, { loc: FRAGILE }), ...users.map((u) => node(u.id))],
      users.map((u) => edge(u.id, "hub")),
    );
    const hubOut = withRiskTiers(noGit).nodes.find((n) => n.id === "hub");
    expect(hubOut?.metrics.dependents).toBe(EXPOSED);
    expect(hubOut?.metrics.risk).toBeUndefined();
  });

  it("replaces earlier values and is deterministic", () => {
    const once = withRiskTiers(g);
    expect(withRiskTiers(once)).toEqual(once);
  });
});
