import type { AnalysisMeta, Graph, UnresolvedReason } from "@epoch-dev/core";

/** How many unresolved imports and cycles the human summary lists before eliding. */
export const SUMMARY_LIST_LIMIT = 20;

const pad = (label: string, value: number) =>
  `  ${label.padEnd(11)}${String(value).padStart(7)}`;

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
  return `${lines.join("\n")}\n`;
}
