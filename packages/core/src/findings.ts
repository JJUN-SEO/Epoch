import type { Confidence, Finding, FindingKind } from "./schemas/index.js";
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

/*
 * What users see (ADR-007, "soft alerts, never verdicts"): finding kinds and
 * confidence levels have plain, hedged names, shared by the app and the CLI.
 */

/** User-facing names of the finding kinds. "Dead" never appears as a fact. */
export const FINDING_KIND_LABELS: Readonly<Record<FindingKind, string>> = {
  "dead-branch": "Branch that likely never runs",
  "stale-flag": "Possibly stale flag",
  "unreachable-file": "Possibly unused file",
};

/** User-facing names of the confidence levels. */
export const CONFIDENCE_LABELS: Readonly<Record<Confidence, string>> = {
  high: "Worth a look",
  medium: "Maybe",
  low: "Unsure",
};

/** The rubric caps (CLAUDE.md "Confidence rubric"): the level each caps at, and why. */
export const RUBRIC_CAPS = {
  "exported-constant": {
    level: "medium",
    reason:
      "exported, so another module or a build-time define may override it",
  },
  "debug-name": {
    level: "low",
    reason: "the name looks like a debug or compile-time toggle",
  },
  "weak-only": {
    level: "low",
    reason: "the calls match an SDK method name, but no SDK import was found",
  },
  "dynamic-import-prefix": {
    level: "low",
    reason: "a dynamic import may load it at run time",
  },
  "framework-convention": {
    level: "low",
    reason: "a framework loads files in this location by convention",
  },
  "convention-roots-only": {
    level: "medium",
    reason:
      "no manifest or config entry point was found, so entry points are guesses",
  },
  "recently-touched": {
    level: "medium",
    reason: "it changed recently, so it may be new work not wired in yet",
  },
  "history-unusable": {
    level: "medium",
    reason: "git history was not available to check recent changes",
  },
} as const satisfies Record<string, { level: Confidence; reason: string }>;
export type RubricCap = keyof typeof RUBRIC_CAPS;

/**
 * The rubric's rule: start at `start`, and the result is the lowest of it and
 * every cap that applied. Caps come back sorted and de-duplicated.
 */
export function applyCaps(
  start: Confidence,
  caps: readonly RubricCap[],
): { confidence: Confidence; caps: RubricCap[] } {
  const sorted = [...new Set(caps)].sort();
  let confidence = start;
  for (const c of sorted) {
    const level = RUBRIC_CAPS[c].level;
    if (RANK[level] < RANK[confidence]) confidence = level;
  }
  return { confidence, caps: sorted };
}
