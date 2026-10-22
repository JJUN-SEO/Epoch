import { describe, expect, it } from "vitest";
import {
  FIX_SUBJECT,
  byTier,
  percentileOf,
  precisionAtTop,
  tierRank,
  v1Scores,
  type RiskRow,
} from "./risk-eval.js";
import { forwardCommitLog } from "./scorer-eval.js";

const row = (
  id: string,
  tier: RiskRow["tier"],
  laterFixes: number,
  fanIn = 0,
  churn90d = 0,
): RiskRow => ({ id, tier, laterFixes, fanIn, churn90d });

describe("FIX_SUBJECT", () => {
  it("matches fix-like words, not words that merely contain them", () => {
    for (const s of [
      "fix: crash on empty input",
      "Fixes #12",
      "bugfix in parser",
      "Revert regression",
    ]) {
      expect(FIX_SUBJECT.test(s), s).toBe(true);
    }
    for (const s of [
      "feat: prefix option",
      "debugging aids",
      "docs: suffixes",
    ]) {
      expect(FIX_SUBJECT.test(s), s).toBe(false);
    }
  });
});

describe("forwardCommitLog", () => {
  it("keeps each commit's header with its files", () => {
    const out = "\u0001fix: a\n\0M\0a.ts\0\u0001feat: b\n\0A\0b.ts\0M\0a.ts\0";
    expect(forwardCommitLog(out)).toEqual([
      { header: "fix: a", files: ["a.ts"] },
      { header: "feat: b", files: ["a.ts", "b.ts"] },
    ]);
  });
});

describe("the tier evaluation", () => {
  const rows = [
    row("a", "critical", 2, 9, 9),
    row("b", "high", 0, 8, 8),
    row("c", "moderate", 1, 1, 9),
    row("d", "low", 0, 0, 0),
    row("e", "low", 1, 0, 1),
  ];

  it("ranks tiers and counts later fixes per tier", () => {
    expect(tierRank("critical")).toBe(5);
    expect(tierRank("low")).toBe(1);
    expect(byTier(rows).map((t) => [t.tier, t.files, t.fixed])).toEqual([
      ["critical", 1, 1],
      ["high", 1, 0],
      ["moderate", 1, 1],
      ["low-moderate", 0, 0],
      ["low", 2, 1],
    ]);
  });

  it("recomputes the removed v1 score from percentile ranks", () => {
    expect(
      Object.fromEntries(
        percentileOf(
          new Map([
            ["x", 0],
            ["y", 1],
            ["z", 1],
          ]),
        ),
      ),
    ).toEqual({
      x: 1 / 6,
      y: 4 / 6,
      z: 4 / 6,
    });
    const s = v1Scores(rows);
    // a has the top fan-in and (tied) top churn.
    expect(s.get("a")).toBeCloseTo(100 * (0.55 * 0.9 + 0.45 * 0.8), 10);
    expect(Math.max(...s.values())).toBe(s.get("a"));
  });

  it("compares the top two tiers with as many top v1 files", () => {
    // Top tiers: a (fixed) and b (not). v1's top two: a (85.5) and c (63.5,
    // above b's 61.0 on churn), both fixed later.
    expect(precisionAtTop(rows)).toEqual({ k: 2, tiers: 0.5, v1: 1 });
  });
});
