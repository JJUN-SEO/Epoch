import { describe, expect, it } from "vitest";
import {
  detectFormat,
  mapCoverage,
  parseCobertura,
  parseLcov,
} from "./coverage.js";

const LCOV = [
  "TN:",
  "SF:/home/runner/work/app/app/src/a.ts",
  "FN:1,f",
  "DA:1,3",
  "DA:2,0",
  "DA:3,1",
  "LF:3",
  "LH:2",
  "end_of_record",
  // The same file again (a second test run): a line hit there counts.
  "SF:/home/runner/work/app/app/src/a.ts",
  "DA:2,5",
  "end_of_record",
  // Summary only, Windows path.
  "SF:C:\\work\\app\\src\\b.ts",
  "LF:10",
  "LH:4",
  "end_of_record",
  "",
].join("\n");

const COBERTURA = `<?xml version="1.0" ?>
<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">
<coverage line-rate="0.5" version="7.6">
  <!-- generated -->
  <sources>
    <source>/home/runner/work/app/app/pkg</source>
  </sources>
  <packages>
    <package name="pkg">
      <classes>
        <class name="mod" filename="mod.py" line-rate="0.5">
          <methods>
            <method name="f"><lines><line number="1" hits="1"/></lines></method>
          </methods>
          <lines>
            <line number="1" hits="1"/>
            <line number="2" hits="0"/>
            <line number="3" hits="2" branch="true"/>
            <line number="4" hits="0"/>
          </lines>
        </class>
        <class name="odd" filename="tom&amp;jerry.py">
          <lines><line number="1" hits="0"/></lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>`;

describe("coverage reports", () => {
  it("detects the format", () => {
    expect(detectFormat(LCOV)).toBe("lcov");
    expect(detectFormat(COBERTURA)).toBe("cobertura");
    expect(detectFormat("hello")).toBeUndefined();
  });

  it("reads lcov line data, merging repeated records, and summary-only records", () => {
    expect(Object.fromEntries(parseLcov(LCOV))).toEqual({
      "/home/runner/work/app/app/src/a.ts": { lines: 3, covered: 3 },
      "C:/work/app/src/b.ts": { lines: 10, covered: 4 },
    });
  });

  it("reads Cobertura class lines once (not the method-level repeats)", () => {
    const { sources, files } = parseCobertura(COBERTURA);
    expect(sources).toEqual(["/home/runner/work/app/app/pkg"]);
    expect(Object.fromEntries(files)).toEqual({
      "mod.py": { lines: 4, covered: 2 },
      "tom&jerry.py": { lines: 1, covered: 0 },
    });
  });

  it("survives malformed XML without hanging", () => {
    const broken = `<coverage><class filename="a.py"><lines><line number="1" hits=`;
    expect(parseCobertura(broken).files.size).toBe(0);
    const long = `<coverage>${"<a b='c' ".repeat(20000)}`;
    expect(parseCobertura(long).files.size).toBe(0);
  });
});

describe("mapCoverage", () => {
  const repo = ["src/a.ts", "src/b.ts", "lib/src/a.ts", "pkg/mod.py", "a.ts"];
  const c = { lines: 2, covered: 1 };

  it("maps CI absolute paths to the longest analyzed file they end with", () => {
    const m = mapCoverage(
      new Map([
        ["/home/runner/work/app/app/src/a.ts", c],
        ["C:/work/app/src/b.ts", c],
        ["/elsewhere/node_modules/dep/index.js", c],
      ]),
      repo,
    );
    expect([...m.files.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(m.unmatched).toBe(1);
  });

  it("joins Cobertura sources with filenames", () => {
    const m = mapCoverage(new Map([["mod.py", c]]), repo, [
      "/home/runner/work/app/app/pkg",
    ]);
    expect([...m.files.keys()]).toEqual(["pkg/mod.py"]);
  });

  it("maps a relative path from a package folder only when it fits one file", () => {
    const one = mapCoverage(new Map([["mod.py", c]]), repo);
    expect([...one.files.keys()]).toEqual(["pkg/mod.py"]);
    const many = mapCoverage(new Map([["src/a.ts", c]]), [
      "x/src/a.ts",
      "y/src/a.ts",
    ]);
    expect(many.files.size).toBe(0);
    expect(many.ambiguous).toBe(1);
  });
});
