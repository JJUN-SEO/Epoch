import { canonicalizeGraph } from "./canonical.js";
import { LANGUAGE_TIERS } from "./languages.js";
import type { Graph, GraphNode } from "./schemas/index.js";

/*
 * The v1 risk score (CLAUDE.md "Risk score"): each input is percentile-ranked
 * across the scored nodes, then
 *   risk = 100 * (0.4 * fanIn + 0.3 * churn + 0.3 * (1 - coverage)),
 * or 100 * (0.55 * fanIn + 0.45 * churn) for a node without coverage. A node
 * without churn (no git history) gets no score. Pure.
 */

export type RiskInput = "fanIn" | "churn" | "coverage";

export interface RiskComponent {
  readonly input: RiskInput;
  /** The raw metric (coverage as a 0..1 fraction). */
  readonly value: number;
  /** Its percentile rank among the scored nodes that have it, 0..1. */
  readonly percentile: number;
  readonly weight: number;
}

export interface RiskBreakdown {
  /** 0..100, one decimal. */
  readonly score: number;
  readonly components: readonly RiskComponent[];
  /** Inputs this node lacks, so its formula was reweighted. */
  readonly missing: readonly RiskInput[];
}

/** By default only source-language nodes are scored, not imported assets. */
export const isScoredNode = (n: GraphNode): boolean =>
  LANGUAGE_TIERS[n.language] !== undefined;

/**
 * Percentile rank with ties at their mean rank:
 * (values below + half the equal values) / count. Order-independent.
 */
export function percentileRanks(
  values: ReadonlyMap<string, number>,
): Map<string, number> {
  const sorted = [...values.values()].sort((a, b) => a - b);
  const n = sorted.length;
  const below = (v: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const atOrBelow = (v: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] ?? 0) <= v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out = new Map<string, number>();
  for (const [id, v] of values) {
    const lt = below(v);
    out.set(id, (lt + 0.5 * (atOrBelow(v) - lt)) / n);
  }
  return out;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** Each scored node's risk and how it was computed. */
export function riskBreakdowns(
  graph: Graph,
  isScored: (n: GraphNode) => boolean = isScoredNode,
): Map<string, RiskBreakdown> {
  const scored = graph.nodes.filter(
    (n) => isScored(n) && n.metrics.churn90d !== undefined,
  );
  const metric = (pick: (n: GraphNode) => number | undefined) =>
    new Map(
      scored.flatMap((n) => {
        const v = pick(n);
        return v === undefined ? [] : [[n.id, v] as const];
      }),
    );
  const fanIn = percentileRanks(metric((n) => n.metrics.fanIn));
  const churn = percentileRanks(metric((n) => n.metrics.churn90d));
  const coverage = percentileRanks(metric((n) => n.metrics.coverage));

  const out = new Map<string, RiskBreakdown>();
  for (const n of scored) {
    const pf = fanIn.get(n.id) ?? 0;
    const pc = churn.get(n.id) ?? 0;
    const pcov = coverage.get(n.id);
    const hasCoverage = pcov !== undefined && n.metrics.coverage !== undefined;
    const weights = hasCoverage
      ? { fanIn: 0.4, churn: 0.3, coverage: 0.3 }
      : { fanIn: 0.55, churn: 0.45, coverage: 0 };
    const components: RiskComponent[] = [
      {
        input: "fanIn",
        value: n.metrics.fanIn,
        percentile: pf,
        weight: weights.fanIn,
      },
      {
        input: "churn",
        value: n.metrics.churn90d ?? 0,
        percentile: pc,
        weight: weights.churn,
      },
      ...(hasCoverage
        ? [
            {
              input: "coverage" as const,
              value: n.metrics.coverage ?? 0,
              percentile: pcov,
              weight: weights.coverage,
            },
          ]
        : []),
    ];
    const raw =
      weights.fanIn * pf +
      weights.churn * pc +
      (hasCoverage ? weights.coverage * (1 - pcov) : 0);
    out.set(n.id, {
      score: round1(100 * raw),
      components,
      missing: hasCoverage ? [] : ["coverage"],
    });
  }
  return out;
}

/** The graph with metrics.riskScore set on every scored node (and cleared elsewhere). */
export function withRiskScores(
  graph: Graph,
  isScored: (n: GraphNode) => boolean = isScoredNode,
): Graph {
  const risks = riskBreakdowns(graph, isScored);
  return canonicalizeGraph({
    ...graph,
    nodes: graph.nodes.map((n) => {
      const { riskScore: _old, ...metrics } = n.metrics;
      const risk = risks.get(n.id);
      return {
        ...n,
        metrics:
          risk === undefined ? metrics : { ...metrics, riskScore: risk.score },
      };
    }),
  });
}
