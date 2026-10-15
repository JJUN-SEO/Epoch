import { compareCodeUnits, globMatcher, type Finding } from "@epoch-dev/core";
import { deadBranchFindings } from "./dead-branch.js";
import type { FindingsInput, FindingsOutput, HistoryStatus } from "./input.js";
import { staleFlagFindings, unassessableUsages } from "./stale-flag.js";
import { unreachableFindings } from "./unreachable.js";

/**
 * The Findings stage (CLAUDE.md pipeline, stage 8): every detector over the
 * scored Graph and the files' facts, with the deterministic rubric. Pure
 * apart from the history provider it is handed. Findings are candidates for
 * review, never verdicts: each carries evidence, caveats and the caps that
 * applied.
 */
export async function runFindings(
  input: FindingsInput,
): Promise<FindingsOutput> {
  const suppressed = globMatcher(input.config.findings.ignore);
  const status = input.history?.status();
  const history: HistoryStatus =
    status === undefined
      ? "off"
      : status.usable
        ? "usable"
        : (status.reason ?? "not-a-repo");
  const usable = history === "usable" && input.history !== undefined;
  const { staleAfterDays, longLived } = input.config.flags;

  const findings: Finding[] = [
    ...deadBranchFindings(input.files, suppressed, input.hash),
    ...(usable
      ? await staleFlagFindings(input.files, suppressed, {
          history: input.history,
          now: input.now,
          staleAfterDays,
          longLived,
          hash: input.hash,
        })
      : []),
    ...(await unreachableFindings({
      graph: input.graph,
      files: input.files,
      packages: input.packages,
      roots: input.roots,
      projectDirs: input.projectDirs,
      frameworks: input.frameworks,
      suppressed,
      ...(input.history ? { history: input.history } : {}),
      historyUsable: usable,
      now: input.now,
      staleAfterDays,
      hash: input.hash,
    })),
  ];
  findings.sort(
    (a, b) =>
      compareCodeUnits(a.kind, b.kind) ||
      compareCodeUnits(a.subject.name, b.subject.name) ||
      compareCodeUnits(a.id, b.id),
  );
  return {
    findings,
    unassessableFlags: unassessableUsages(input.files, suppressed),
    history,
  };
}
