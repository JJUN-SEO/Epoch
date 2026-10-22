import {
  applyCaps,
  type ConstantCondition,
  type Finding,
  type RubricCap,
} from "@epoch-dev/core";
import type { FindingsFile } from "./input.js";

/*
 * dead-branch (CLAUDE.md rubric): a branch guarded by a statically constant
 * condition. The adapters already left out reassigned, shadowed, typing-only
 * and environment-derived names; here the rubric sets the confidence.
 */

const DEBUG_TOKENS = new Set([
  "debug",
  "trace",
  "verbose",
  "dev",
  "development",
  "profile",
  "profiling",
]);

/** Names that look like debug or compile-time toggles (ADR-007 lists them). */
export function looksLikeDebugToggle(name: string): boolean {
  if (name === "TYPE_CHECKING" || name === "__debug__") return true;
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return tokens.some((t) => DEBUG_TOKENS.has(t));
}

const SCOPE_TEXT: Readonly<Record<ConstantCondition["scope"], string>> = {
  literal: "",
  local: "in this function",
  module: "in this file",
  exported: "exported from this file",
};

export function deadBranchFindings(
  files: readonly FindingsFile[],
  suppressed: (path: string) => boolean,
  hash: (text: string) => string,
): Finding[] {
  const out: Finding[] = [];
  for (const file of files) {
    if (file.facts.isGenerated || suppressed(file.path)) continue;
    const conditions = [...file.facts.constantConditions].sort(
      (a, b) => a.line - b.line || a.endLine - b.endLine,
    );
    const ordinal = new Map<string, number>();
    for (const c of conditions) {
      const key = c.name ?? "\u0000literal";
      const n = ordinal.get(key) ?? 0;
      ordinal.set(key, n + 1);
      const caps: RubricCap[] = [];
      if (c.scope === "exported") caps.push("exported-constant");
      if (c.name !== null && looksLikeDebugToggle(c.name))
        caps.push("debug-name");
      const rubric = applyCaps("high", caps);
      const value = String(c.value);
      const branch =
        c.deadBranch === "then" ? "the branch it guards" : "its else branch";
      const subjectText =
        c.name === null
          ? `The condition is always \`${value}\` (a literal)`
          : `\`${c.name}\` is the constant \`${value}\` ${SCOPE_TEXT[c.scope]} and is never reassigned`;
      const caveats = [
        "Static analysis reads this file only; a build step, macro or code generator could still change what runs here.",
      ];
      if (c.name === null) {
        caveats.push(
          "A literal condition is sometimes a switch someone flips by hand on purpose.",
        );
      }
      if (caps.includes("exported-constant")) {
        caveats.push(
          "It is exported, so other code or a build-time define may override the value.",
        );
      }
      if (caps.includes("debug-name")) {
        caveats.push(
          "The name looks like a debug or compile-time toggle, which is often kept on purpose.",
        );
      }
      out.push({
        id: hash(`dead-branch\u0000${file.path}\u0000${key}\u0000${String(n)}`),
        kind: "dead-branch",
        subject: { type: "file", name: file.path },
        confidence: rubric.confidence,
        locations: [{ file: file.path, line: c.line, endLine: c.endLine }],
        evidence: [`${subjectText}, so ${branch} likely never runs.`],
        caveats,
        suggestedAction:
          c.name === null
            ? "This branch looks unreachable. If that is intended, the branch and the condition could be removed."
            : `This branch looks unreachable while \`${c.name}\` stays \`${value}\`. If that is intended, the branch could be removed.`,
        caps: rubric.caps,
      });
    }
  }
  return out;
}
