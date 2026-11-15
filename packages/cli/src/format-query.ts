import {
  CONFIDENCE_LABELS,
  FINDING_KIND_LABELS,
  type DependencyPath,
  type Finding,
} from "@epoch-dev/core";
import type {
  ExplainReport,
  ImpactReport,
  Neighbor,
  PathReport,
} from "./query.js";

/*
 * The human reports of `epoch impact`, `path` and `explain`. Every list says
 * how many entries it left out, and candidates keep their hedged names.
 */

/** How many entries a list shows before eliding. */
export const QUERY_LIST_LIMIT = 20;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

const percent = (share: number) => `${(share * 100).toFixed(0)}%`;

function capped<T>(
  items: readonly T[],
  line: (item: T) => string,
  noun: string,
): string[] {
  const shown = items.slice(0, QUERY_LIST_LIMIT).map(line);
  const more = items.length - shown.length;
  return more > 0
    ? [...shown, `    ...and ${String(more)} more ${noun}`]
    : shown;
}

/** "3 files and 1 package", as blast radius counts them. */
function nodeCount(byKind: ImpactReport["byKind"]): string {
  const parts = [
    ...(byKind.file > 0 || byKind.package === 0
      ? [plural(byKind.file, "file")]
      : []),
    ...(byKind.package > 0 ? [plural(byKind.package, "package")] : []),
  ];
  return parts.join(" and ");
}

function where(f: Finding): string {
  const [first] = f.locations;
  if (!first) return f.subject.name;
  return first.line === undefined
    ? first.file
    : `${first.file}:${String(first.line)}`;
}

const candidateLine = (f: Finding) =>
  `  [${CONFIDENCE_LABELS[f.confidence]}] ${FINDING_KIND_LABELS[f.kind]}: ${where(f)}`;

const CANDIDATE_NOTE =
  "Candidates are prompts to review, never verdicts: see their caveats with `epoch findings`.";

/** The folders a change reaches, most affected first. */
function folders(r: ImpactReport): [string, number][] {
  return Object.entries(r.byDirectory).sort(
    ([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
  );
}

export function formatImpact(r: ImpactReport): string {
  const lines: string[] = [];
  const reach =
    r.total === 0
      ? "nothing else depends on them"
      : `${nodeCount(r.byKind)} affected, up to ${plural(r.maxDepth, "import")} away`;
  lines.push(
    `Change impact: ${plural(r.changed.length, "changed file")} analyzed; ${reach}${r.likely ? " (likely mode: hints followed)" : ""}`,
  );
  if (r.changed.length > 0) {
    lines.push("Changed, riskiest first:");
    lines.push(
      ...capped(
        r.changed,
        (c) => {
          const facts = [
            ...(c.dependents === undefined
              ? []
              : [plural(c.dependents, "dependent")]),
            ...(c.findings.length > 0
              ? [plural(c.findings.length, "candidate")]
              : []),
            ...(c.paths.length > 1 || c.paths[0] !== c.id
              ? [`changed: ${c.paths.join(", ")}`]
              : []),
          ];
          return `  ${(c.risk?.tier ?? "no tier").padEnd(13)} ${c.id}${facts.length > 0 ? `  (${facts.join("; ")})` : ""}`;
        },
        "changed files",
      ),
    );
  }
  if (r.unanalyzed.length > 0) {
    lines.push(
      `Not analyzed (not in the graph): ${r.unanalyzed.slice(0, QUERY_LIST_LIMIT).join(", ")}${r.unanalyzed.length > QUERY_LIST_LIMIT ? `, and ${String(r.unanalyzed.length - QUERY_LIST_LIMIT)} more` : ""}`,
    );
  }
  if (r.total > 0) {
    lines.push("Affected, by folder:");
    lines.push(
      ...capped(
        folders(r),
        ([dir, n]) => `  ${String(n).padStart(5)}  ${dir}`,
        "folders",
      ),
    );
    if (r.viaHints > 0) {
      lines.push(
        `  ${plural(r.viaHints, "file")} reached only through likely relations (hints, not proven imports)`,
      );
    }
  }
  if (r.candidates.length > 0) {
    lines.push("Candidates in the changed files:");
    lines.push(...capped(r.candidates, candidateLine, "candidates"));
    lines.push(`  ${CANDIDATE_NOTE}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Repository strings as plain Markdown text: nothing in them is read as markup. */
const md = (s: string): string =>
  s.replace(/[\\`*_{}[\]<>|#~]/g, "\\$&").replace(/\s+/g, " ");

/** The same report as Markdown, for a CI job summary or a pull request. */
export function formatImpactMarkdown(r: ImpactReport): string {
  const lines: string[] = ["### Epoch change impact", ""];
  const riskiest =
    r.highestTier === undefined
      ? ""
      : ` Riskiest change: **${r.highestTier}**.`;
  lines.push(
    r.total === 0
      ? `**${plural(r.changed.length, "changed file")}** analyzed; nothing else depends on them.${riskiest}`
      : `**${plural(r.changed.length, "changed file")}** analyzed; they reach **${nodeCount(r.byKind)}**, up to ${plural(r.maxDepth, "import")} away.${riskiest}`,
    "",
  );
  if (r.changed.length > 0) {
    lines.push(
      "| Changed | Risk tier | Files that depend on it | Candidates |",
      "|---|---|---|---|",
      ...r.changed
        .slice(0, QUERY_LIST_LIMIT)
        .map(
          (c) =>
            `| ${md(c.id)} | ${c.risk?.tier ?? "no tier"} | ${c.dependents === undefined ? "" : String(c.dependents)} | ${String(c.findings.length)} |`,
        ),
    );
    if (r.changed.length > QUERY_LIST_LIMIT) {
      lines.push(
        "",
        `...and ${String(r.changed.length - QUERY_LIST_LIMIT)} more changed files.`,
      );
    }
    lines.push("");
  }
  if (r.unanalyzed.length > 0) {
    lines.push(
      `Not analyzed (not in the graph): ${r.unanalyzed.slice(0, QUERY_LIST_LIMIT).map(md).join(", ")}${r.unanalyzed.length > QUERY_LIST_LIMIT ? `, and ${String(r.unanalyzed.length - QUERY_LIST_LIMIT)} more` : ""}`,
      "",
    );
  }
  if (r.total > 0) {
    const all = folders(r);
    lines.push(
      "| Affected folder | Files |",
      "|---|---|",
      ...all
        .slice(0, QUERY_LIST_LIMIT)
        .map(([dir, n]) => `| ${md(dir)} | ${String(n)} |`),
    );
    if (all.length > QUERY_LIST_LIMIT) {
      lines.push(
        "",
        `...and ${String(all.length - QUERY_LIST_LIMIT)} more folders.`,
      );
    }
    lines.push("");
    if (r.viaHints > 0) {
      lines.push(
        `${plural(r.viaHints, "file")} reached only through likely relations (hints, not proven imports).`,
        "",
      );
    }
  }
  if (r.candidates.length > 0) {
    lines.push(
      "Candidates in the changed files:",
      "",
      ...r.candidates
        .slice(0, QUERY_LIST_LIMIT)
        .map(
          (f) =>
            `- ${CONFIDENCE_LABELS[f.confidence]}: ${FINDING_KIND_LABELS[f.kind]}, ${md(where(f))}`,
        ),
      "",
      CANDIDATE_NOTE,
      "",
    );
  }
  return lines.join("\n");
}

function hops(p: DependencyPath): string[] {
  return p.hops.map((h) => {
    const what = h.hint
      ? `likely ${h.kind} (${h.confidence.toFixed(2)}), a hint`
      : h.kind;
    const why = h.evidence.length > 0 ? `; ${h.evidence.join("; ")}` : "";
    return `  ${h.source} -> ${h.target}  ${what}${why}`;
  });
}

function chain(p: DependencyPath): string[] {
  const hints =
    p.viaHints > 0
      ? `; ${plural(p.viaHints, "hop is a likely relation", "hops are likely relations")}, not ${p.viaHints === 1 ? "a proven import" : "proven imports"}`
      : "";
  return [
    `${p.from} depends on ${p.to} (${plural(p.hops.length, "hop")}${hints}):`,
    ...hops(p),
  ];
}

export function formatPath(r: PathReport, likely: boolean): string {
  if (r.from === r.to) return `${r.from} is the same file.\n`;
  if (r.path) return `${chain(r.path).join("\n")}\n`;
  const lines = [`${r.from} does not depend on ${r.to}.`];
  if (r.reverse) lines.push(...chain(r.reverse));
  else {
    lines.push(
      likely
        ? "Neither depends on the other, through proven imports or likely relations."
        : "Neither depends on the other through proven imports (add --likely to follow hints).",
    );
  }
  return `${lines.join("\n")}\n`;
}

const neighborLine = (n: Neighbor) =>
  `    ${n.id}${n.kind === "import" ? "" : `  ${n.kind}`}${n.evidence.length > 0 ? `  (${n.evidence.join("; ")})` : ""}`;

export function formatExplain(r: ExplainReport): string {
  const lines: string[] = [r.id];
  const row = (label: string, value: string) =>
    lines.push(`  ${label.padEnd(13)}${value}`);
  row(
    "language",
    `${r.language}${r.languageTier === undefined ? "" : `, tier ${r.languageTier}`}`,
  );
  row("lines", String(r.lines));
  if (r.members) row("package of", plural(r.members.length, "file"));
  if (r.entryPoint) row("entry point", r.entryPoint.join("; "));
  if (r.risk) {
    row(
      "risk",
      `${r.risk.tier} (${r.risk.archetype}): ${r.risk.exposure}, ${r.risk.change}, ${r.risk.fragility}`,
    );
  } else if (r.languageTier !== undefined) {
    row("risk", "no tier (it needs git history)");
  }
  if (r.dependents !== undefined) {
    row("dependents", `${String(r.dependents)} (direct and indirect)`);
  }
  if (r.commits90d !== undefined) {
    row("commits", `${String(r.commits90d)} in the last 90 days`);
  }
  row(
    "coverage",
    r.coverage === undefined
      ? "none (no report covers it; Epoch never runs tests)"
      : `${percent(r.coverage)} of its lines run in tests`,
  );
  const list = <T>(
    title: string,
    items: readonly T[],
    line: (item: T) => string,
    noun: string,
  ) => {
    if (items.length === 0) return;
    lines.push(`  ${title} (${String(items.length)}):`);
    lines.push(...capped(items, line, noun));
  };
  list("imports", r.imports, neighborLine, "imports");
  list("imported by", r.importedBy, neighborLine, "importers");
  list(
    "likely relations, hints not facts",
    r.likely,
    (l) =>
      `    ${l.direction === "out" ? "->" : "<-"} ${l.id}  ${l.kind} ${l.confidence.toFixed(2)}${l.evidence.length > 0 ? `  (${l.evidence.join("; ")})` : ""}`,
    "likely relations",
  );
  if (r.externals.length > 0) {
    row("externals", r.externals.join(", "));
  }
  list(
    "unresolved imports",
    r.unresolved,
    (u) =>
      `    ${u.from}:${String(u.line)}  ${u.specifier ?? "<non-literal>"}  ${u.reason}`,
    "unresolved imports",
  );
  if (r.findings.length > 0) {
    lines.push(`  candidates (${String(r.findings.length)}):`);
    lines.push(
      ...capped(r.findings, (f) => `  ${candidateLine(f)}`, "candidates"),
    );
    lines.push(`    ${CANDIDATE_NOTE}`);
  }
  return `${lines.join("\n")}\n`;
}
