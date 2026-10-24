import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CoverageChoices, reportInside } from "./coverage-report";

let base: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cov-")));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function write(rel: string, text = ""): string {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

describe("reportInside", () => {
  it("answers the repo-relative path of a file inside the project", () => {
    const root = path.join(base, "project");
    const report = write("project/build/reports/lcov.info");
    expect(reportInside(root, report)).toBe("build/reports/lcov.info");
  });

  it("refuses files outside the project, symlinks out of it, folders and missing files", () => {
    const root = path.join(base, "project");
    write("project/src/a.ts");
    const outside = write("elsewhere/lcov.info");
    expect(reportInside(root, outside)).toBeUndefined();
    expect(reportInside(root, path.join(root, "src"))).toBeUndefined();
    expect(reportInside(root, path.join(root, "gone.info"))).toBeUndefined();
    expect(reportInside(root, root)).toBeUndefined();
    // A sibling folder whose name starts with the project's.
    expect(
      reportInside(root, write("project-other/lcov.info")),
    ).toBeUndefined();
    if (process.platform !== "win32") {
      const link = path.join(root, "linked.info");
      fs.symlinkSync(outside, link);
      expect(reportInside(root, link)).toBeUndefined();
    }
  });
});

describe("CoverageChoices", () => {
  it("keeps each project's report across instances, and clears it", () => {
    const file = path.join(base, "data", "coverage-reports.json");
    const first = new CoverageChoices(file);
    expect(first.get("/p/one")).toBeUndefined();
    first.set("/p/one", "build/lcov.info");
    first.set("/p/two", "coverage.xml");
    const again = new CoverageChoices(file);
    expect(again.get("/p/one")).toBe("build/lcov.info");
    expect(again.get("/p/two")).toBe("coverage.xml");
    again.set("/p/one", undefined);
    expect(new CoverageChoices(file).get("/p/one")).toBeUndefined();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it("starts empty from a missing, corrupt or foreign file", () => {
    const file = path.join(base, "coverage-reports.json");
    expect(new CoverageChoices(file).get("/p")).toBeUndefined();
    fs.writeFileSync(file, "{not json");
    expect(new CoverageChoices(file).get("/p")).toBeUndefined();
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 1, reports: { "/p": "../escape.info" } }),
    );
    expect(new CoverageChoices(file).get("/p")).toBeUndefined();
  });
});
