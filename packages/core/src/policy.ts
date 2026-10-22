import type { EdgeKind, GraphEdge } from "./schemas/index.js";

/**
 * The edge traversal policy (CLAUDE.md "Edge traversal policy") as data, so
 * every analysis follows the same table instead of re-deciding it.
 */

/** Resolver-proven edge kinds. */
export const FACT_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  "import",
  "dynamic-import",
  "reexport",
  "type-only",
  "via-barrel",
]);

/** Inferred edge kinds (M6). */
export const HINT_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  "cochange",
  "shared-string",
  "semantic",
]);

/**
 * Blast radius in certain mode, and fan-in/fan-out. `via-barrel` is excluded:
 * it records the physical import path, not a real dependency.
 */
export const CERTAIN_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  "import",
  "dynamic-import",
  "reexport",
  "type-only",
]);

/** Certain mode with the type-only toggle switched off. */
export const CERTAIN_EDGE_KINDS_WITHOUT_TYPES: ReadonlySet<EdgeKind> =
  new Set<EdgeKind>(["import", "dynamic-import", "reexport"]);

/** Reachability for findings: every fact kind, including via-barrel. */
export const REACHABILITY_EDGE_KINDS: ReadonlySet<EdgeKind> = FACT_EDGE_KINDS;

/** Default display: every fact kind except via-barrel (toggle to show). */
export const DISPLAY_EDGE_KINDS: ReadonlySet<EdgeKind> = CERTAIN_EDGE_KINDS;

/**
 * An inferred relation (a hint: dashed in the UI, followed only by "likely"
 * analyses), as opposed to a resolver-proven fact (CLAUDE.md principle 3).
 */
export const isHintEdge = (
  e: Pick<GraphEdge, "kind" | "confidence">,
): boolean => HINT_EDGE_KINDS.has(e.kind) || e.confidence < 1;
