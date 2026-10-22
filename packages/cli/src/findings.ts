import {
  CONFIDENCE_LABELS,
  FINDING_KIND_LABELS,
  RUBRIC_CAPS,
  type AnalysisMeta,
  type Confidence,
  type Finding,
  type RubricCap,
} from "@epoch-dev/core";

/*
 * The human report of `epoch findings` (ADR-007, "soft alerts, never
 * verdicts"): hedged names, caveats before evidence, the reason behind every
 * cap, and what could not be checked.
 */

const HISTORY_NOTE: Readonly<
  Record<AnalysisMeta["findings"]["history"], string | undefined>
> = {
  usable: undefined,
  off: "Git history was off: possibly stale flags were not checked and recent changes could not be seen.",
  "not-a-repo":
    "Not a git repository (or git is unavailable): possibly stale flags were not checked and recent changes could not be seen.",
  shallow:
    "Shallow clone: possibly stale flags were not checked and recent changes could not be seen. Fetch the full history for these checks.",
  "too-short":
    "The history is shorter than flags.staleAfterDays, so possibly stale flags were not checked.",
};

const isCap = (c: string): c is RubricCap => c in RUBRIC_CAPS;

function where(f: Finding): string {
  const shown = f.locations
    .slice(0, 5)
    .map((l) =>
      l.line === undefined
        ? l.file
        : l.endLine === undefined || l.endLine === l.line
          ? `${l.file}:${String(l.line)}`
          : `${l.file}:${String(l.line)}-${String(l.endLine)}`,
    );
  const more = f.locations.length - shown.length;
  return more > 0
    ? `${shown.join(", ")} and ${String(more)} more`
    : shown.join(", ");
}

export interface FindingsReport {
  readonly findings: readonly Finding[];
  readonly dismissed: ReadonlySet<string>;
  readonly hidden: {
    readonly dismissed: number;
    readonly belowMinConfidence: number;
  };
  readonly minConfidence: Confidence;
  readonly meta: AnalysisMeta;
}

export function formatFindings(r: FindingsReport): string {
  const lines: string[] = [];
  const count = (c: Confidence) =>
    r.findings.filter((f) => f.confidence === c).length;
  const parts = (["high", "medium", "low"] as const)
    .filter((c) => count(c) > 0)
    .map((c) => `${String(count(c))} ${CONFIDENCE_LABELS[c].toLowerCase()}`);
  lines.push(
    r.findings.length === 0
      ? "No findings to review at this level."
      : `${String(r.findings.length)} ${r.findings.length === 1 ? "candidate" : "candidates"} to review: ${parts.join(", ")}.`,
    "These are candidates, not verdicts: static analysis cannot see reflection, tooling or runtime configuration.",
    "",
  );
  for (const f of r.findings) {
    const flag = r.dismissed.has(f.id) ? " (dismissed)" : "";
    lines.push(
      `[${CONFIDENCE_LABELS[f.confidence]}] ${FINDING_KIND_LABELS[f.kind]}: ${f.subject.name}${flag}`,
    );
    lines.push(`    at ${where(f)}`);
    for (const c of f.caveats) lines.push(`    keep in mind: ${c}`);
    for (const e of f.evidence) lines.push(`    why: ${e}`);
    const caps = f.caps.filter(isCap);
    if (caps.length > 0) {
      lines.push(
        `    rated ${CONFIDENCE_LABELS[f.confidence]} because ${caps.map((c) => RUBRIC_CAPS[c].reason).join("; ")}`,
      );
    }
    lines.push(`    next step: ${f.suggestedAction}`, "");
  }
  const notes: string[] = [];
  if (r.hidden.belowMinConfidence > 0) {
    notes.push(
      `${String(r.hidden.belowMinConfidence)} more below ${CONFIDENCE_LABELS[r.minConfidence]} (use --min-confidence low to list them).`,
    );
  }
  if (r.hidden.dismissed > 0) {
    notes.push(
      `${String(r.hidden.dismissed)} dismissed (use --include-dismissed to list them).`,
    );
  }
  const history = HISTORY_NOTE[r.meta.findings.history];
  if (history !== undefined) notes.push(history);
  for (const fw of r.meta.findings.frameworks) {
    notes.push(
      `${fw.name} detected${fw.dir === "" ? "" : ` in ${fw.dir}`}: it loads some files by convention. List them under entryPoints in epoch.config.json for better results.`,
    );
  }
  if (r.meta.findings.unassessableFlags > 0) {
    notes.push(
      `${String(r.meta.findings.unassessableFlags)} flag ${r.meta.findings.unassessableFlags === 1 ? "usage has" : "usages have"} a key that is not a string literal and could not be assessed.`,
    );
  }
  for (const w of r.meta.config.warnings) notes.push(w);
  if (notes.length > 0) lines.push("Notes:", ...notes.map((n) => `  ${n}`), "");
  return lines.join("\n");
}
