import type {
  CandidatePair,
  FileContext,
  FileRole,
  HintSignals,
  RelationScorer,
  ScoredRelation,
} from "@epoch-dev/core";
import coefficients from "./coefficients.json" with { type: "json" };

/*
 * HeuristicScorer (CLAUDE.md "RelationScorer"): the no-model baseline every
 * other scorer must beat, and the default offline. It scores a candidate
 * with a logistic of its signals' features; the coefficients are data,
 * fitted by `pnpm bench:scorers` on a training split (ADR-008). It calls no
 * model: the embedding cosine, when present, came from the local candidate
 * generator.
 */

export interface HeuristicCoefficients {
  readonly intercept: number;
  readonly cochangeRatio: number;
  readonly cochangeSupport: number;
  readonly stringWeight: number;
  readonly embeddingCosine: number;
}

export const DEFAULT_COEFFICIENTS: HeuristicCoefficients = coefficients;

/**
 * The features, in coefficient order: co-change ratio (commits together
 * over the target's commits), co-change support (log of commits together),
 * shared-string weight, embedding cosine. Missing signals give 0.
 */
export function heuristicFeatures(signals: HintSignals): number[] {
  const c = signals.cochange;
  return [
    c && c.targetCommits > 0 ? c.together / c.targetCommits : 0,
    c ? Math.log1p(c.together) : 0,
    signals.strings?.weight ?? 0,
    signals.embedding?.cosine ?? 0,
  ];
}

export class HeuristicScorer implements RelationScorer {
  private readonly weights: HeuristicCoefficients;

  constructor(weights: HeuristicCoefficients = DEFAULT_COEFFICIENTS) {
    this.weights = weights;
  }

  probability(signals: HintSignals): number {
    const w = this.weights;
    const [ratio = 0, support = 0, strings = 0, cosine = 0] =
      heuristicFeatures(signals);
    const z =
      w.intercept +
      w.cochangeRatio * ratio +
      w.cochangeSupport * support +
      w.stringWeight * strings +
      w.embeddingCosine * cosine;
    return 1 / (1 + Math.exp(-z));
  }

  scoreRelations(candidates: CandidatePair[]): Promise<ScoredRelation[]> {
    return Promise.resolve(
      candidates.map((c) => ({
        source: c.source,
        target: c.target,
        probability: this.probability(c.signals),
        rationale: "",
      })),
    );
  }

  /** Roles are not part of M6's hints; the heuristic proposes none. */
  classifyFiles(_files: FileContext[]): Promise<FileRole[]> {
    return Promise.resolve([]);
  }
}
