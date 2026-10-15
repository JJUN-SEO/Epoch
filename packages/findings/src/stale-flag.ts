import {
  applyCaps,
  type FlagUsage,
  type Finding,
  type GitHistoryProvider,
  type RubricCap,
} from "@epoch-dev/core";
import { daysBetween, isoDate, plural, type FindingsFile } from "./input.js";

/*
 * stale-flag (CLAUDE.md rubric): a flag with a literal key, not declared
 * long-lived, introduced at least staleAfterDays ago AND with every usage's
 * lines last touched at least staleAfterDays ago. Strong usages give Medium,
 * weak-only Low. Never High: age alone does not prove a flag is unused.
 */

interface Usage {
  readonly file: string;
  readonly usage: FlagUsage;
}

const DETECTION_TEXT: Readonly<Record<FlagUsage["detection"], string>> = {
  "sdk-call": "read through a feature-flag SDK call",
  "wrapper-call": "read through a configured wrapper function",
  "env-read": "read as an environment variable with a configured prefix",
};

export async function staleFlagFindings(
  files: readonly FindingsFile[],
  suppressed: (path: string) => boolean,
  opts: {
    readonly history: GitHistoryProvider;
    readonly now: Date;
    readonly staleAfterDays: number;
    readonly longLived: readonly string[];
    readonly hash: (text: string) => string;
  },
): Promise<Finding[]> {
  const byFlag = new Map<string, Usage[]>();
  for (const file of files) {
    if (file.facts.isGenerated || suppressed(file.path)) continue;
    for (const usage of file.facts.flagUsages) {
      if (usage.flagName === null || opts.longLived.includes(usage.flagName))
        continue;
      const list = byFlag.get(usage.flagName) ?? [];
      list.push({ file: file.path, usage });
      byFlag.set(usage.flagName, list);
    }
  }
  const out: Finding[] = [];
  const limit = opts.staleAfterDays;
  for (const [flag, usages] of [...byFlag].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    usages.sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : a.usage.line - b.usage.line,
    );
    const files = [...new Set(usages.map((u) => u.file))];
    const introduced = await opts.history.firstIntroduced(flag, files);
    if (introduced === null || daysBetween(introduced, opts.now) < limit)
      continue;
    let newest: Date | undefined;
    let fresh = false;
    for (const u of usages) {
      const touched = await opts.history.lastTouched(
        u.file,
        u.usage.line,
        u.usage.endLine,
      );
      if (touched === null || daysBetween(touched, opts.now) < limit) {
        fresh = true;
        break;
      }
      if (newest === undefined || touched > newest) newest = touched;
    }
    if (fresh || newest === undefined) continue;

    const strong = usages.some((u) => u.usage.strength === "strong");
    const caps: RubricCap[] = strong ? [] : ["weak-only"];
    const rubric = applyCaps("medium", caps);
    const detections = [
      ...new Set(usages.map((u) => DETECTION_TEXT[u.usage.detection])),
    ];
    const providers = [
      ...new Set(usages.flatMap((u) => u.usage.provider ?? [])),
    ];
    const evidence = [
      `First added ${plural(daysBetween(introduced, opts.now), "day")} ago (${isoDate(introduced)}).`,
      usages.length === 1
        ? `Its only usage was last changed ${plural(daysBetween(newest, opts.now), "day")} ago (${isoDate(newest)}).`
        : `All ${String(usages.length)} usages (in ${plural(files.length, "file")}) were last changed at least ${plural(daysBetween(newest, opts.now), "day")} ago (most recently ${isoDate(newest)}).`,
      `It is ${detections.join("; ")}${providers.length > 0 ? ` (${providers.join(", ")})` : ""}.`,
    ];
    const caveats = [
      "Age alone does not show a flag is finished: long-lived operational flags such as kill switches are legitimate. If this one is meant to stay, add it to flags.longLived in epoch.config.json.",
      "The flag's state in your flag provider is not checked; it may still be switched for some users.",
      "History is approximate: renamed or moved files can make code look older or newer than it is.",
    ];
    if (!strong) {
      caveats.unshift(
        "The calls match an SDK method name, but these files import no matching SDK, so this may be a different API.",
      );
    }
    out.push({
      id: opts.hash(`stale-flag\u0000${flag}`),
      kind: "stale-flag",
      subject: { type: "flag", name: flag },
      confidence: rubric.confidence,
      locations: usages.map((u) => ({
        file: u.file,
        line: u.usage.line,
        endLine: u.usage.endLine,
      })),
      evidence,
      caveats,
      suggestedAction:
        "This flag may be stale. If it is fully rolled out or abandoned, consider removing it and the code path it no longer needs.",
      caps: rubric.caps,
    });
  }
  return out;
}

/** Usages whose key is not a string literal, which no rubric can assess. */
export function unassessableUsages(
  files: readonly FindingsFile[],
  suppressed: (path: string) => boolean,
): number {
  let n = 0;
  for (const file of files) {
    if (file.facts.isGenerated || suppressed(file.path)) continue;
    for (const u of file.facts.flagUsages) if (u.flagName === null) n++;
  }
  return n;
}
