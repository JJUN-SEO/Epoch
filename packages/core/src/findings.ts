import type { Confidence, Finding } from "./schemas/index.js";
import type { FindingFilter } from "./interfaces/api.js";

const RANK: Readonly<Record<Confidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Whether `c` is at least `min` (high > medium > low). */
export const atLeast = (c: Confidence, min: Confidence): boolean =>
  RANK[c] >= RANK[min];

/** Higher confidence first. */
export const byConfidence = (a: Confidence, b: Confidence): number =>
  RANK[b] - RANK[a];

/**
 * Findings matching a filter (EpochApi.getFindings): kinds, minimum
 * confidence, and dismissed ones left out unless asked for. Order kept.
 */
export function filterFindings(
  findings: readonly Finding[],
  filter: FindingFilter = {},
  dismissed: ReadonlySet<string> = new Set(),
): Finding[] {
  const kinds = filter.kinds ? new Set(filter.kinds) : undefined;
  return findings.filter(
    (f) =>
      (kinds === undefined || kinds.has(f.kind)) &&
      (filter.minConfidence === undefined ||
        atLeast(f.confidence, filter.minConfidence)) &&
      (filter.includeDismissed === true || !dismissed.has(f.id)),
  );
}
