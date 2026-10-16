import { canonicalizeGraph } from "./canonical.js";
import { LANGUAGE_TIERS } from "./languages.js";
import { CERTAIN_EDGE_KINDS, isHintEdge } from "./policy.js";
import {
  RiskTier,
  type Graph,
  type GraphNode,
  type RiskArchetype,
} from "./schemas/index.js";

export type { RiskArchetype };

/*
 * Risk tiers (CLAUDE.md "Risk tiers", ADR-015): an ordinal tier and an
 * archetype from three facts with fixed thresholds, never a made-up number.
 * - Exposure: how many nodes depend on it, transitively, over the certain
 *   edge set of blast radius (type-only included, hints and via-barrel not).
 * - Change: commits in the last 90 days (churn90d).
 * - Fragility: size, or line coverage when a report exists.
 * Pure, so the Score stage, the CLI and the static demo share it.
 */

/** Default thresholds (ADR-015); to be tuned with evidence (bench:risk). */
export const RISK_DEFAULTS = {
  /** Exposed: more than this many dependents. */
  exposedAbove: 5,
  /** Hot: at least this many commits in 90 days; warm: 1 to one fewer. */
  hotFrom: 3,
  /** Fragile: more than this many lines... */
  fragileAboveLoc: 300,
  /** ...or line coverage below this, when a coverage report covers it. */
  fragileBelowCoverage: 0.5,
} as const;

export type RiskThresholds = {
  readonly [K in keyof typeof RISK_DEFAULTS]: number;
};

/** Most to least risky. */
export const RISK_TIERS: readonly RiskTier[] = RiskTier.options;

export interface RiskFacts {
  readonly dependents: number;
  readonly churn90d: number;
  readonly loc: number;
  /** Line coverage 0..1, when a report covers the node. */
  readonly coverage?: number;
}

export interface RiskAssessment {
  readonly tier: RiskTier;
  readonly archetype: RiskArchetype;
  readonly exposure: "exposed" | "contained";
  readonly change: "hot" | "warm" | "quiet";
  readonly fragility: "fragile" | "sturdy";
}

/** The tier and archetype for a node's facts: the first matching rule of ADR-015's table. */
export function assessRisk(
  f: RiskFacts,
  t: RiskThresholds = RISK_DEFAULTS,
): RiskAssessment {
  const exposure = f.dependents > t.exposedAbove ? "exposed" : "contained";
  const change =
    f.churn90d >= t.hotFrom ? "hot" : f.churn90d > 0 ? "warm" : "quiet";
  const fragility =
    f.loc > t.fragileAboveLoc ||
    (f.coverage !== undefined && f.coverage < t.fragileBelowCoverage)
      ? "fragile"
      : "sturdy";
  const exposed = exposure === "exposed";
  const fragile = fragility === "fragile";
  const rule = ((): Pick<RiskAssessment, "tier" | "archetype"> => {
    if (exposed && change === "hot" && fragile)
      return { tier: "critical", archetype: "volatile-core" };
    if (exposed && (change === "hot" || (change === "warm" && fragile)))
      return { tier: "high", archetype: "active-hotspot" };
    if (exposed && change === "warm")
      return { tier: "moderate", archetype: "warm-core" };
    if (!exposed && (change === "hot" || (change === "warm" && fragile)))
      return { tier: "moderate", archetype: "fragile-leaf" };
    if (exposed) return { tier: "low-moderate", archetype: "frozen-core" };
    return { tier: "low", archetype: "stable-leaf" };
  })();
  return { ...rule, exposure, change, fragility };
}

/**
 * Each node's count of transitive dependents over the certain edge set (the
 * traversal policy's "Blast radius, certain", type-only included). A reverse
 * search per node, cycle-safe.
 */
export function transitiveDependents(graph: Graph): Map<string, number> {
  const rev = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (
      e.source === e.target ||
      isHintEdge(e) ||
      !CERTAIN_EDGE_KINDS.has(e.kind)
    )
      continue;
    const list = rev.get(e.target);
    if (list) list.push(e.source);
    else rev.set(e.target, [e.source]);
  }
  const out = new Map<string, number>();
  for (const n of graph.nodes) {
    const seen = new Set<string>([n.id]);
    const stack = [n.id];
    while (stack.length > 0) {
      const id = stack.pop() ?? "";
      for (const dependent of rev.get(id) ?? []) {
        if (seen.has(dependent)) continue;
        seen.add(dependent);
        stack.push(dependent);
      }
    }
    out.set(n.id, seen.size - 1);
  }
  return out;
}

/** By default only source-language nodes get a tier, not imported assets. */
export const isScoredNode = (n: GraphNode): boolean =>
  LANGUAGE_TIERS[n.language] !== undefined;

/**
 * The graph with metrics.dependents on every node and metrics.risk on every
 * scored node with git history (churn90d); earlier values are replaced.
 */
export function withRiskTiers(
  graph: Graph,
  isScored: (n: GraphNode) => boolean = isScoredNode,
  thresholds: RiskThresholds = RISK_DEFAULTS,
): Graph {
  const dependents = transitiveDependents(graph);
  return canonicalizeGraph({
    ...graph,
    nodes: graph.nodes.map((n) => {
      const { dependents: _d, risk: _r, ...metrics } = n.metrics;
      const count = dependents.get(n.id) ?? 0;
      const churn = metrics.churn90d;
      const risk =
        churn !== undefined && isScored(n)
          ? assessRisk(
              {
                dependents: count,
                churn90d: churn,
                loc: n.loc,
                ...(metrics.coverage === undefined
                  ? {}
                  : { coverage: metrics.coverage }),
              },
              thresholds,
            )
          : undefined;
      return {
        ...n,
        metrics: {
          ...metrics,
          dependents: count,
          ...(risk
            ? { risk: { tier: risk.tier, archetype: risk.archetype } }
            : {}),
        },
      };
    }),
  });
}
