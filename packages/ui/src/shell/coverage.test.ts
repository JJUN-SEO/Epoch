import { describe, expect, it } from "vitest";
import type { AnalysisInfo } from "@epoch-dev/core";
import { coverageLines, coverageSummary } from "./coverage";

const report = {
  source: "coverage/lcov.info",
  format: "lcov" as const,
  files: 12,
  unmatched: 0,
  ambiguous: 0,
};
const info = (coverage: AnalysisInfo["coverage"]) =>
  ({ coverage }) as AnalysisInfo;

describe("coverageSummary", () => {
  it("names the one report, or counts several", () => {
    expect(coverageSummary(info({ reports: [report] }))?.text).toBe(
      "Test coverage: coverage/lcov.info",
    );
    const two = coverageSummary(
      info({
        reports: [
          {
            ...report,
            source: "packages/a/coverage/clover.xml",
            format: "clover",
          },
          { ...report, unmatched: 3 },
        ],
      }),
    );
    expect(two?.text).toBe("Test coverage: 2 reports");
    expect(two?.title).toBe(
      "Coverage from packages/a/coverage/clover.xml (Clover XML): 12 files; coverage/lcov.info (lcov): 12 files, 3 entries not in this project. A report may be older than the code.",
    );
  });

  it("says when there is none, and why a chosen one was not read", () => {
    expect(coverageSummary(info({ reports: [] }))?.text).toBe(
      "No test coverage report",
    );
    const missing = coverageSummary(
      info({
        reports: [],
        chosen: { path: "build/lcov.info", problem: "missing" },
      }),
    );
    expect(missing?.text).toBe("Coverage report not read");
    expect(missing?.title).toBe(
      "The chosen report build/lcov.info is missing. Risk judges fragility by file size alone.",
    );
    expect(coverageSummary(null)).toBeNull();
  });
});

describe("coverageLines", () => {
  it("lists reports, or the reason there are none", () => {
    expect(coverageLines({ reports: [] })).toEqual(["No report found."]);
    expect(
      coverageLines({
        reports: [],
        chosen: { path: "notes.txt", problem: "unrecognized" },
      }),
    ).toEqual(["The chosen report notes.txt is not a format Epoch reads."]);
    expect(
      coverageLines({ reports: [{ ...report, files: 1, format: "go" }] }),
    ).toEqual(["coverage/lcov.info (Go profile): 1 file"]);
  });
});
