import { RISK_TIERS, type RiskTier } from "@epoch-dev/core";

/*
 * The pure half of bench:risk (ADR-015): which later commits count as fixes,
 * the tiers' later-fix rates, and the comparison with the weighted score the
 * tiers replaced. The runner (risk.ts) reads git and runs the engine.
 */

/**
 * A commit counts as a fix when its subject says so. A proxy for defects:
 * it misses fixes described otherwise and counts some that are not.
 */
export const FIX_SUBJECT =
  /\b(fix|fixes|fixed|fixing|bug|bugs|bugfix|regression|hotfix)\b/i;

export interface RiskRow {
  readonly id: string;
  readonly tier: RiskTier;
  readonly fanIn: number;
  readonly churn90d: number;
  readonly coverage?: number;
  /** Fix commits that touched it in the label window. */
  readonly laterFixes: number;
}

/**
 * Percentile rank with ties at their mean rank: (values below + half the
 * equal values) / count. As the v1 score computed it.
 */
export function percentileOf(
  values: ReadonlyMap<string, number>,
): Map<string, number> {
  const sorted = [...values.values()].sort((a, b) => a - b);
  const n = sorted.length;
  const count = (v: number, inclusive: boolean) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const x = sorted[mid] ?? 0;
      if (x < v || (inclusive && x === v)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const out = new Map<string, number>();
  for (const [id, v] of values) {
    const below = count(v, false);
    out.set(id, (below + 0.5 * (count(v, true) - below)) / n);
  }
  return out;
}

/**
 * The removed v1 score, kept here only to compare against: percentile
 * ranks across the rows, then 100 * (0.4 fanIn + 0.3 churn + 0.3 (1 -
 * coverage)), or 0.55 fanIn + 0.45 churn without coverage.
 */
export function v1Scores(rows: readonly RiskRow[]): Map<string, number> {
  const rank = (pick: (r: RiskRow) => number | undefined) =>
    percentileOf(
      new Map(
        rows.flatMap((r) => {
          const v = pick(r);
          return v === undefined ? [] : [[r.id, v] as const];
        }),
      ),
    );
  const fanIn = rank((r) => r.fanIn);
  const churn = rank((r) => r.churn90d);
  const coverage = rank((r) => r.coverage);
  return new Map(
    rows.map((r) => {
      const f = fanIn.get(r.id) ?? 0;
      const c = churn.get(r.id) ?? 0;
      const cov = coverage.get(r.id);
      const score =
        cov === undefined
          ? 0.55 * f + 0.45 * c
          : 0.4 * f + 0.3 * c + 0.3 * (1 - cov);
      return [r.id, 100 * score] as const;
    }),
  );
}

/** Higher is riskier: critical 5 ... low 1. */
export const tierRank = (t: RiskTier): number =>
  RISK_TIERS.length - RISK_TIERS.indexOf(t);

/** Rows and later-fix rate per tier, most risky first. */
export function byTier(rows: readonly RiskRow[]) {
  return RISK_TIERS.map((tier) => {
    const these = rows.filter((r) => r.tier === tier);
    const fixed = these.filter((r) => r.laterFixes > 0).length;
    return {
      tier,
      files: these.length,
      fixed,
      rate: these.length === 0 ? Number.NaN : fixed / these.length,
    };
  });
}

/**
 * At the top: the later-fix rate of the files in the two riskiest tiers,
 * and of the same number of files ranked highest by the v1 score (ties at
 * the cut broken by id, so the count matches).
 */
export function precisionAtTop(rows: readonly RiskRow[]): {
  readonly k: number;
  readonly tiers: number;
  readonly v1: number;
} {
  const top = rows.filter((r) => tierRank(r.tier) >= 4);
  const k = top.length;
  const scores = v1Scores(rows);
  const byScore = [...rows].sort(
    (a, b) =>
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
      (a.id < b.id ? -1 : 1),
  );
  const rate = (rs: readonly RiskRow[]) =>
    rs.length === 0
      ? Number.NaN
      : rs.filter((r) => r.laterFixes > 0).length / rs.length;
  return { k, tiers: rate(top), v1: rate(byScore.slice(0, k)) };
}
