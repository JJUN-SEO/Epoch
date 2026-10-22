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
 * fitted by `pnpm bench:scorers` on a training split (ADR-008). There are
 * two sets: one for candidates with an embedding cosine (the local model
 * ran, so every candidate whose files it read has one) and one for
 * candidates without (no model, as on Intel Macs). It calls no model: the
 * cosine, when present, came from the local candidate generator.
 */

export interface HeuristicCoefficients {
  readonly intercept: number;
  readonly cochangeRatio: number;
  readonly cochangeSupport: number;
  readonly stringWeight: number;
  readonly embeddingCosine: number;
}

export interface HeuristicModel {
  /** For candidates without an embedding cosine. */
  readonly withoutEmbeddings: HeuristicCoefficients;
  /** For candidates with one. */
  readonly withEmbeddings: HeuristicCoefficients;
}

export const DEFAULT_COEFFICIENTS: HeuristicModel = coefficients;

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
  private readonly model: HeuristicModel;

  /** One set of coefficients applies to every candidate; a model picks by the embedding signal. */
  constructor(
    weights: HeuristicModel | HeuristicCoefficients = DEFAULT_COEFFICIENTS,
  ) {
    this.model =
      "intercept" in weights
        ? { withoutEmbeddings: weights, withEmbeddings: weights }
        : weights;
  }

  probability(signals: HintSignals): number {
    const w = signals.embedding
      ? this.model.withEmbeddings
      : this.model.withoutEmbeddings;
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
