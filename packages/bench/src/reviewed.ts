import type { Comparison, Verdict } from "./edges.js";

/**
 * Verdicts a human reviewed for one-off disagreements that no general rule
 * covers (PLAN.md: classify every disagreement before quoting numbers). Each
 * entry says what was checked. Keyed by repository, side, source and target.
 */
export const REVIEWED: Readonly<
  Record<string, { verdict: Verdict; note: string }>
> = {
  "vitest:epoch-only:test/e2e/project-references/packages/project-b/src/b.test-d.ts->test/e2e/project-references/packages/project-a/src/index.ts":
    {
      verdict: "tool-wrong",
      note: "project-b/node_modules/project-a is a symlink committed in the repo (git mode 120000) to ../../project-a; Node and TypeScript resolve through it",
    },
};

/** Replaces rule verdicts with reviewed ones, marking them in the reason. */
export function applyReviews(repo: string, c: Comparison): Comparison {
  return {
    ...c,
    disagreements: c.disagreements.map((d) => {
      const review = REVIEWED[`${repo}:${d.side}:${d.from}->${d.to}`];
      return review
        ? { ...d, verdict: review.verdict, reason: `reviewed: ${review.note}` }
        : d;
    }),
  };
}
