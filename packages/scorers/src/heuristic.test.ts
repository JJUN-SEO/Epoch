import { describe, expect, it } from "vitest";
import type { CandidatePair } from "@epoch-dev/core";
import { HeuristicScorer, heuristicFeatures } from "./heuristic.js";

const pair = (signals: CandidatePair["signals"]): CandidatePair => ({
  source: "a.ts",
  target: "b.ts",
  signals,
});

describe("HeuristicScorer", () => {
  it("turns each candidate's signals into features: ratio, support, string weight, cosine", () => {
    expect(
      heuristicFeatures({
        cochange: { together: 3, sourceCommits: 10, targetCommits: 4 },
        strings: { shared: ["x.y"], weight: 0.9 },
        embedding: { cosine: 0.8 },
      }),
    ).toEqual([0.75, Math.log1p(3), 0.9, 0.8]);
    expect(heuristicFeatures({})).toEqual([0, 0, 0, 0]);
  });

  it("scores with a logistic of the features, so more evidence means a higher probability", async () => {
    const scorer = new HeuristicScorer({
      intercept: -1,
      cochangeRatio: 2,
      cochangeSupport: 0,
      stringWeight: 1,
      embeddingCosine: 0,
    });
    const [weak, strong] = await scorer.scoreRelations([
      pair({ strings: { shared: ["x.y"], weight: 0.5 } }),
      pair({
        cochange: { together: 4, sourceCommits: 4, targetCommits: 4 },
        strings: { shared: ["x.y"], weight: 0.5 },
      }),
    ]);
    expect(weak?.probability).toBeCloseTo(1 / (1 + Math.exp(0.5)), 10);
    expect(strong?.probability).toBeCloseTo(1 / (1 + Math.exp(-1.5)), 10);
    expect(strong?.rationale).toBe("");
  });

  it("scores a candidate with an embedding cosine with the set fitted with embeddings", () => {
    const scorer = new HeuristicScorer({
      withoutEmbeddings: {
        intercept: 0,
        cochangeRatio: 0,
        cochangeSupport: 0,
        stringWeight: 0,
        embeddingCosine: 0,
      },
      withEmbeddings: {
        intercept: -1,
        cochangeRatio: 0,
        cochangeSupport: 0,
        stringWeight: 0,
        embeddingCosine: 2,
      },
    });
    const co = { together: 3, sourceCommits: 3, targetCommits: 3 };
    expect(scorer.probability({ cochange: co })).toBe(0.5);
    expect(
      scorer.probability({ cochange: co, embedding: { cosine: 0.5 } }),
    ).toBe(0.5);
    expect(
      scorer.probability({ cochange: co, embedding: { cosine: 1 } }),
    ).toBeCloseTo(1 / (1 + Math.exp(-1)), 10);
  });

  it("is deterministic and classifies no roles", async () => {
    const scorer = new HeuristicScorer();
    const c = [
      pair({ cochange: { together: 3, sourceCommits: 3, targetCommits: 3 } }),
    ];
    expect(await scorer.scoreRelations(c)).toEqual(
      await scorer.scoreRelations(c),
    );
    expect(await scorer.classifyFiles([])).toEqual([]);
  });
});
