/*
 * Hint defaults (ADR-008). Provisional until `pnpm bench:scorers` measures
 * them; the threshold is the UI's default for likely mode and the finding
 * cap's line.
 */
export const HINT_DEFAULTS = {
  /** Scores below this make no hint edge. */
  floor: 0.2,
  /** Outgoing hint edges kept per node, the most likely first. */
  perNode: 8,
  /** Likely mode's default threshold, and the strong-hint finding cap's. */
  threshold: 0.5,
  cochange: { days: 365, maxFiles: 50, minSupport: 3 },
  strings: { maxFiles: 5 },
} as const;
