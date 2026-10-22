import { compareCodeUnits } from "../canonical.js";
import type { GraphEdge } from "../schemas/graph.js";
import { byPair } from "./cochange.js";
import type {
  CandidatePair,
  HintSignals,
  ScoredRelation,
} from "../interfaces/services.js";

export interface HintEdgeOptions {
  /** Scores below this make no edge. */
  readonly floor: number;
  /** Each node keeps at most this many outgoing hint edges, the most likely first. */
  readonly perNode: number;
  /** True when a model scored the candidates: its edges are `semantic` hints with provenance `model`. */
  readonly byModel: boolean;
  /** "source\0target" of fact edges: a hint in the same direction adds nothing. */
  readonly facts: ReadonlySet<string>;
}

/** Hint confidence stays below 1, which CLAUDE.md reserves for resolver-proven facts. */
const MAX_HINT_CONFIDENCE = 0.99;

function evidenceOf(signals: HintSignals, target: string): string[] {
  const out: string[] = [];
  const c = signals.cochange;
  if (c) {
    out.push(
      `changed in ${String(c.together)} of the ${String(c.targetCommits)} commits that changed ${target}`,
    );
  }
  const s = signals.strings;
  if (s) {
    const quoted = s.shared.slice(0, 3).map((x) => `"${x}"`);
    const more = s.shared.length - quoted.length;
    out.push(
      s.shared.length === 1
        ? `both use the rare string ${quoted.join("")}`
        : `both use the rare strings ${quoted.join(", ")}${more > 0 ? ` and ${String(more)} more` : ""}`,
    );
  }
  const e = signals.embedding;
  if (e) out.push(`similar content (cosine ${e.cosine.toFixed(2)})`);
  return out;
}

function kindOf(
  signals: HintSignals,
  byModel: boolean,
): Pick<GraphEdge, "kind" | "provenance"> {
  if (byModel) return { kind: "semantic", provenance: "model" };
  if (signals.cochange) return { kind: "cochange", provenance: "git-cochange" };
  if (signals.strings)
    return { kind: "shared-string", provenance: "shared-string" };
  return { kind: "semantic", provenance: "embedding" };
}

/**
 * Hint edges from scored candidates (ADR-008): one per directed pair, of the
 * kind of its strongest signal (co-change, then shared strings, then
 * embeddings), or a model's semantic hint. Edges below the floor, edges a
 * fact edge already covers and edges past a node's cap are dropped.
 * Confidence is rounded to three decimals so the canonical graph is stable.
 * Pure.
 */
export function hintEdges(
  candidates: readonly CandidatePair[],
  scored: readonly ScoredRelation[],
  opts: HintEdgeOptions,
): GraphEdge[] {
  const byKey = new Map(
    candidates.map((c) => [`${c.source}\u0000${c.target}`, c]),
  );
  const bySource = new Map<string, GraphEdge[]>();
  for (const s of scored) {
    const key = `${s.source}\u0000${s.target}`;
    const candidate = byKey.get(key);
    if (
      candidate === undefined ||
      s.source === s.target ||
      opts.facts.has(key) ||
      !(s.probability >= opts.floor)
    ) {
      continue;
    }
    const evidence = evidenceOf(candidate.signals, s.target);
    if (opts.byModel && s.rationale !== "") {
      evidence.push(`a model scored it: ${s.rationale}`);
    }
    const edge: GraphEdge = {
      source: s.source,
      target: s.target,
      ...kindOf(candidate.signals, opts.byModel),
      confidence:
        Math.round(Math.min(s.probability, MAX_HINT_CONFIDENCE) * 1000) / 1000,
      evidence,
    };
    const list = bySource.get(s.source) ?? [];
    list.push(edge);
    bySource.set(s.source, list);
  }
  const out: GraphEdge[] = [];
  for (const list of bySource.values()) {
    list.sort(
      (a, b) =>
        b.confidence - a.confidence ||
        (a.target < b.target ? -1 : a.target > b.target ? 1 : 0),
    );
    out.push(...list.slice(0, opts.perNode));
  }
  return out.sort(compareEdges);
}

/** What a hint edge rests on, in words: "co-change", "shared strings"... */
export function hintSourceLabel(
  e: Pick<GraphEdge, "kind" | "provenance">,
): string {
  if (e.provenance === "model") return "a model's judgment";
  if (e.kind === "cochange") return "co-change";
  if (e.kind === "shared-string") return "shared strings";
  return "similar content";
}

/** The canonical edge order: (source, target, kind). */
export function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    compareCodeUnits(a.source, b.source) ||
    compareCodeUnits(a.target, b.target) ||
    compareCodeUnits(a.kind, b.kind)
  );
}

/** One candidate per directed pair, with every generator's signals for it. */
export function mergeCandidates(
  ...lists: readonly (readonly CandidatePair[])[]
): CandidatePair[] {
  const byKey = new Map<string, CandidatePair>();
  for (const list of lists) {
    for (const c of list) {
      const key = `${c.source}\u0000${c.target}`;
      const prev = byKey.get(key);
      byKey.set(key, {
        source: c.source,
        target: c.target,
        signals: { ...prev?.signals, ...c.signals },
      });
    }
  }
  return [...byKey.values()].sort(byPair);
}
