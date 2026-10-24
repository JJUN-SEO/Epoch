import type { AnalysisInfo } from "@epoch-dev/core";

/*
 * What the status bar and the coverage panel say about test coverage
 * (ADR-020). Epoch never runs tests: it reads the report a test runner
 * wrote, so the panel names the commands that write one.
 */

type Coverage = AnalysisInfo["coverage"];

const plural = (n: number, one: string, many = `${one}s`) =>
  `${String(n)} ${n === 1 ? one : many}`;

export const FORMAT_NAMES: Readonly<Record<string, string>> = {
  lcov: "lcov",
  cobertura: "Cobertura XML",
  "istanbul-json": "Istanbul JSON",
  clover: "Clover XML",
  go: "Go profile",
};

/** Commands that write a report Epoch reads, each from its tool's own docs. */
export const COVERAGE_COMMANDS: readonly {
  readonly tool: string;
  readonly command: string;
}[] = [
  { tool: "Vitest", command: "npx vitest run --coverage" },
  { tool: "Jest", command: "npx jest --coverage" },
  { tool: "pytest", command: "coverage run -m pytest && coverage xml" },
  { tool: "Go", command: "go test -coverprofile=cover.out ./..." },
];

const PROBLEMS = {
  missing: "is missing",
  "too-large": "is too large to read",
  unrecognized: "is not a format Epoch reads",
} as const;

/** One line per report used, or why none was. */
export function coverageLines(c: Coverage): string[] {
  if (c.chosen?.problem !== undefined)
    return [
      `The chosen report ${c.chosen.path} ${PROBLEMS[c.chosen.problem]}.`,
    ];
  if (c.reports.length === 0) return ["No report found."];
  return c.reports.map(
    (r) =>
      `${r.source} (${FORMAT_NAMES[r.format] ?? r.format}): ${plural(r.files, "file")}${r.unmatched > 0 ? `, ${String(r.unmatched)} entries not in this project` : ""}`,
  );
}

/** The status bar's line on coverage, or null before an analysis ends. */
export function coverageSummary(info: AnalysisInfo | null): {
  text: string;
  title: string;
} | null {
  const c = info?.coverage;
  if (!c) return null;
  const [first, ...rest] = c.reports;
  if (first === undefined) {
    return c.chosen?.problem !== undefined
      ? {
          text: "Coverage report not read",
          title: `${coverageLines(c).join(" ")} Risk judges fragility by file size alone.`,
        }
      : {
          text: "No test coverage report",
          title:
            "Test coverage is the share of a file's lines your tests run. Epoch never runs your tests: it reads the report your test runner wrote. None was found, so risk judges fragility by file size alone.",
        };
  }
  return {
    text:
      rest.length === 0
        ? `Test coverage: ${first.source}`
        : `Test coverage: ${plural(c.reports.length, "report")}`,
    title: `Coverage from ${coverageLines(c).join("; ")}. A report may be older than the code.`,
  };
}
