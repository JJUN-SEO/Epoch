import {
  RISK_TIERS,
  type AnalysisMeta,
  type Graph,
  type RiskTier,
  type UnresolvedReason,
} from "@epoch-dev/core";

/** How many unresolved imports and cycles the human summary lists before eliding. */
export const SUMMARY_LIST_LIMIT = 20;

const pad = (label: string, value: number) =>
  `  ${label.padEnd(13)}${String(value).padStart(7)}`;

/** How many nodes fall in each risk tier (ADR-015), when any has one. */
function riskLine(graph: Graph): string[] {
  const counts = new Map<RiskTier, number>();
  for (const n of graph.nodes) {
    const tier = n.metrics.risk?.tier;
    if (tier !== undefined) counts.set(tier, (counts.get(tier) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  return [
    `  risk tiers   ${RISK_TIERS.map((t) => `${String(counts.get(t) ?? 0)} ${t}`).join(", ")}`,
  ];
}

/** What the Enrich stage did: hint edges and the sources behind them. */
function hintsLine(h: AnalysisMeta["hints"]): string {
  if (h.scorer === "none") return "  hints        off";
  const c = h.cochange;
  const cochange =
    c.status === "usable" || c.status === "shallow"
      ? `co-change ${String(c.pairs)} pairs from ${String(c.commits)} commits${c.status === "shallow" ? " (shallow clone)" : ""}`
      : `no co-change (${c.status})`;
  const e = h.embeddings;
  const similarity =
    e.status === "ready"
      ? `, similarity ${String(e.pairs)} pairs (${e.model ?? "local model"})`
      : e.status === "unavailable"
        ? `, similarity unavailable (${e.model ?? "local model"} failed to load)`
        : "";
  return `  hints        ${String(h.edges)} likely relations (${h.scorer} scorer): ${cochange}, shared strings ${String(h.strings.pairs)} pairs${similarity}`;
}

/**
 * The human-readable report `epoch analyze` prints without --json. Counts
 * only; it makes no accuracy claims. Every list states how many entries it
 * left out, so a truncated list never reads as complete.
 */
export function formatSummary(graph: Graph, meta: AnalysisMeta): string {
  const lines: string[] = [];
  const adapters = meta.adapters
    .map((a) => `${a.id} v${a.version}, tier ${a.tier}`)
    .join("; ");
  lines.push(
    `Analyzed ${String(meta.counts.filesAnalyzed)} files in ${(meta.timingsMs.total / 1000).toFixed(2)} s (${adapters})`,
  );

  const byReason = new Map<UnresolvedReason, number>();
  for (const u of graph.unresolved) {
    byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
  }
  const reasons = [...byReason]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([r, n]) => `${r} ${String(n)}`)
    .join(", ");
  lines.push(
    pad("nodes", meta.counts.nodes),
    pad("edges", meta.counts.edges),
    pad("externals", meta.counts.externals),
    pad("unresolved", meta.counts.unresolved) +
      (reasons === "" ? "" : `  (${reasons})`),
    pad("cycles", meta.cycles.length),
    pad("skipped", meta.counts.skipped),
    pad("parse errors", meta.counts.parseErrors),
    pad("cache hits", meta.counts.cacheHits),
    pad("parsed", meta.counts.cacheMisses),
  );

  const git = meta.git;
  lines.push(
    "",
    git.status === "usable"
      ? `  git          90-day churn up to ${new Date((git.churnUntil ?? 0) * 1000).toISOString().slice(0, 10)}${git.shallow === true ? " (shallow clone: only the fetched history counts)" : ""}`
      : git.status === "off"
        ? "  git          off"
        : `  git          no churn or risk tiers (${git.status})`,
    ...riskLine(graph),
    meta.coverage === null
      ? "  coverage     none found"
      : `  coverage     ${meta.coverage.source} (${meta.coverage.format}): ${String(meta.coverage.files)} files${meta.coverage.unmatched + meta.coverage.ambiguous > 0 ? `, ${String(meta.coverage.unmatched)} unmatched, ${String(meta.coverage.ambiguous)} ambiguous` : ""}`,
    hintsLine(meta.hints),
  );

  const list = <T>(
    title: string,
    items: readonly T[],
    show: (x: T) => string,
  ) => {
    if (items.length === 0) return;
    lines.push("", `${title}:`);
    for (const x of items.slice(0, SUMMARY_LIST_LIMIT))
      lines.push(`  ${show(x)}`);
    if (items.length > SUMMARY_LIST_LIMIT) {
      lines.push(
        `  ... and ${String(items.length - SUMMARY_LIST_LIMIT)} more (use --json for the full list)`,
      );
    }
  };
  list("Unresolved imports", graph.unresolved, (u) => {
    const spec =
      u.specifier === null ? "<non-literal>" : JSON.stringify(u.specifier);
    const prefix = u.pathPrefix === undefined ? "" : ` under ${u.pathPrefix}`;
    return `${u.from}:${String(u.line)}  ${spec}  ${u.reason}${prefix}`;
  });
  list("Cycles", meta.cycles, (c) => c.join(" -> "));
  list("Skipped files", meta.skipped, (s) => `${s.path}  ${s.reason}`);
  list(
    "Files with syntax errors (facts from them are best-effort)",
    meta.parseErrors,
    (f) => f,
  );
  return `${lines.join("\n")}\n`;
}
