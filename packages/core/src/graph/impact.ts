import { compareCodeUnits } from "../canonical.js";
import type {
  BlastRadiusOptions,
  BlastRadiusResult,
} from "../interfaces/api.js";
import { compareByRisk } from "../risk.js";
import type { Graph, GraphNode, RiskTier } from "../schemas/index.js";
import { reverseImpact } from "./blast-radius.js";

export interface ChangeImpactOptions extends BlastRadiusOptions {
  /**
   * The node a changed path belongs to when it is not a node itself: a Go
   * file's package (ADR-013). Paths it does not place are unanalyzed.
   */
  readonly nodeOf?: (path: string) => string | undefined;
}

export interface ChangedNode {
  readonly id: string;
  /** The changed paths that are this node, sorted. */
  readonly paths: readonly string[];
  readonly risk?: GraphNode["metrics"]["risk"];
  readonly dependents?: number;
  /** Ids of the graph's findings located in those paths, sorted. */
  readonly findings: readonly string[];
}

export interface ChangeImpactResult extends Omit<BlastRadiusResult, "nodeId"> {
  /** By risk (tier, dependents, churn, id): the riskiest change first. */
  readonly changed: readonly ChangedNode[];
  /** Changed paths that are not in the graph (docs, deleted files...), sorted. */
  readonly unanalyzed: readonly string[];
  /** The riskiest tier among the changed nodes; absent when none has a tier. */
  readonly highestTier?: RiskTier;
}

/**
 * What a set of changed files touches (CLAUDE.md "Graph queries"): each
 * changed node with its risk tier and the candidates located in it, and the
 * combined blast radius, one reverse search from all of them, so a node is
 * counted once at its shortest depth. Changed nodes are never listed as
 * affected. Pure.
 */
export function changeImpact(
  graph: Graph,
  changedPaths: readonly string[],
  opts: ChangeImpactOptions,
): ChangeImpactResult {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const pathsOf = new Map<string, Set<string>>();
  const unanalyzed = new Set<string>();
  for (const path of changedPaths) {
    const id = nodes.has(path) ? path : opts.nodeOf?.(path);
    if (id === undefined || !nodes.has(id)) {
      unanalyzed.add(path);
      continue;
    }
    const paths = pathsOf.get(id) ?? new Set<string>();
    paths.add(path);
    pathsOf.set(id, paths);
  }

  const located = new Map<string, Set<string>>();
  for (const f of graph.findings) {
    for (const l of f.locations) {
      const ids = located.get(l.file) ?? new Set<string>();
      ids.add(f.id);
      located.set(l.file, ids);
    }
  }

  const changed = [...pathsOf.keys()]
    .flatMap((id) => nodes.get(id) ?? [])
    .sort(compareByRisk)
    .map((n): ChangedNode => {
      const paths = [...(pathsOf.get(n.id) ?? [])].sort(compareCodeUnits);
      const findings = new Set(
        paths.flatMap((p) => [...(located.get(p) ?? [])]),
      );
      return {
        id: n.id,
        paths,
        ...(n.metrics.risk ? { risk: n.metrics.risk } : {}),
        ...(n.metrics.dependents === undefined
          ? {}
          : { dependents: n.metrics.dependents }),
        findings: [...findings].sort(compareCodeUnits),
      };
    });

  const highest = changed.find((c) => c.risk)?.risk?.tier;
  return {
    changed,
    unanalyzed: [...unanalyzed].sort(compareCodeUnits),
    ...reverseImpact(
      graph,
      changed.map((c) => c.id),
      opts,
    ),
    ...(highest === undefined ? {} : { highestTier: highest }),
  };
}
