import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectFormat,
  type FileCoverage,
  mapCoverage,
  parseClover,
  parseCobertura,
  parseGoProfile,
  parseIstanbulJson,
  parseLcov,
  rebaseGoPaths,
} from "./coverage.js";

/** A report written by the real tool (see fixtures/coverage-reports/README.md). */
const report = (path: string): string =>
  readFileSync(
    new URL(`./fixtures/coverage-reports/${path}`, import.meta.url),
    "utf8",
  );

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
    expect(parseClover(broken).size).toBe(0);
  });
});

describe("reports written by the real tools", () => {
  const counts = (files: ReadonlyMap<string, FileCoverage>, repo: string[]) =>
    Object.fromEntries(mapCoverage(files, repo).files);

  it("detects every format", () => {
    expect(detectFormat(report("vitest/lcov.info"))).toBe("lcov");
    expect(detectFormat(report("vitest/coverage-final.json"))).toBe(
      "istanbul-json",
    );
    expect(detectFormat(report("vitest/clover.xml"))).toBe("clover");
    // A DOCTYPE before the root element.
    expect(detectFormat(report("vitest/cobertura-coverage.xml"))).toBe(
      "cobertura",
    );
    expect(detectFormat(report("coveragepy/coverage.lcov"))).toBe("lcov");
    expect(detectFormat(report("coveragepy/coverage.xml"))).toBe("cobertura");
    expect(detectFormat(report("go/coverage.out"))).toBe("go");
    expect(detectFormat("{}")).toBeUndefined();
    expect(detectFormat("mode: sometimes\n")).toBeUndefined();
  });

  it("gives the same counts from vitest's four formats, matching its summary", () => {
    const repo = ["src/math.ts", "src/untested.ts"];
    const expected = {
      "src/math.ts": { lines: 6, covered: 3 },
      "src/untested.ts": { lines: 2, covered: 1 },
    };
    const cobertura = parseCobertura(report("vitest/cobertura-coverage.xml"));
    expect(counts(parseLcov(report("vitest/lcov.info")), repo)).toEqual(
      expected,
    );
    expect(
      counts(parseIstanbulJson(report("vitest/coverage-final.json")), repo),
    ).toEqual(expected);
    expect(counts(parseClover(report("vitest/clover.xml")), repo)).toEqual(
      expected,
    );
    expect(
      Object.fromEntries(
        mapCoverage(cobertura.files, repo, cobertura.sources).files,
      ),
    ).toEqual(expected);
  });

  it("gives the same counts from coverage.py's lcov and XML, matching its summary", () => {
    const repo = ["pkg/__init__.py", "pkg/calc.py", "pkg/sub/util.py"];
    const expected = {
      "pkg/calc.py": { lines: 9, covered: 6 },
      "pkg/sub/util.py": { lines: 2, covered: 1 },
    };
    const xml = parseCobertura(report("coveragepy/coverage.xml"));
    const fromXml = mapCoverage(xml.files, repo, xml.sources);
    const fromLcov = mapCoverage(
      parseLcov(report("coveragepy/coverage.lcov")),
      repo,
    );
    expect(Object.fromEntries(fromXml.files)).toEqual(expected);
    expect(Object.fromEntries(fromLcov.files)).toEqual(expected);
    // The test file is in the report but not in this repo list.
    expect(fromXml.unmatched).toBe(1);
    expect(fromLcov.unmatched).toBe(1);
  });

  it("counts Go statements per block, matching go test's percentages", () => {
    const profile = parseGoProfile(report("go/coverage.out"));
    expect(Object.fromEntries(profile)).toEqual({
      "example.com/covgo/calc/calc.go": { lines: 6, covered: 3 },
      "example.com/covgo/internal/util/util.go": { lines: 1, covered: 0 },
    });
  });

  it("maps Go import paths through each module's folder", () => {
    const profile = parseGoProfile(report("go/coverage.out"));
    const root = rebaseGoPaths(profile, [
      { path: "example.com/covgo", dir: "" },
    ]);
    expect([...root.files.keys()]).toEqual([
      "calc/calc.go",
      "internal/util/util.go",
    ]);
    expect(root.outside).toBe(0);
    const nested = rebaseGoPaths(profile, [
      { path: "example.com/covgo", dir: "go" },
      { path: "example.com/covgo/internal", dir: "other/internal" },
    ]);
    // The longest module path wins.
    expect([...nested.files.keys()]).toEqual([
      "go/calc/calc.go",
      "other/internal/util/util.go",
    ]);
  });

  it("counts Go files outside every module as outside, not as suffix matches", () => {
    const profile = new Map([
      ["example.com/covgo/calc/calc.go", { lines: 1, covered: 1 }],
      ["golang.org/x/text/calc/calc.go", { lines: 1, covered: 0 }],
    ]);
    const r = rebaseGoPaths(profile, [{ path: "example.com/covgo", dir: "" }]);
    expect([...r.files.keys()]).toEqual(["calc/calc.go"]);
    expect(r.outside).toBe(1);
    // No go.mod known: paths are left for the suffix rules.
    expect(rebaseGoPaths(profile, []).files.size).toBe(2);
  });

  it("merges Go blocks repeated across test binaries", () => {
    const text = [
      "mode: count",
      "m/a.go:3.10,5.2 2 0",
      "m/a.go:6.10,7.2 1 0",
      "m/a.go:3.10,5.2 2 4",
      "m/a.go:bad line",
      "",
    ].join("\n");
    expect(Object.fromEntries(parseGoProfile(text))).toEqual({
      "m/a.go": { lines: 3, covered: 2 },
    });
  });

  it("reads Clover statement and condition lines, not method lines", () => {
    // PHPUnit's layout: the full path in `name`, method lines beside statements.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<coverage generated="1">
  <project timestamp="1">
    <package name="App">
      <file name="/work/app/src/Foo.php">
        <class name="Foo" namespace="App"><metrics methods="1"/></class>
        <line num="5" type="method" name="bar" count="2"/>
        <line num="7" type="stmt" count="2"/>
        <line num="8" type="stmt" count="0"/>
        <line num="9" type="cond" count="1"/>
      </file>
    </package>
  </project>
</coverage>`;
    expect(detectFormat(xml)).toBe("clover");
    expect(Object.fromEntries(parseClover(xml))).toEqual({
      "/work/app/src/Foo.php": { lines: 3, covered: 2 },
    });
  });

  it("reads Istanbul JSON the way istanbul-lib-coverage counts lines", () => {
    // Two statements on one line: the line is hit if either is.
    const json = JSON.stringify({
      "/w/a.js": {
        path: "/w/a.js",
        statementMap: {
          "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 5 } },
          "1": { start: { line: 1, column: 6 }, end: { line: 1, column: 9 } },
          "2": { start: { line: 2, column: 0 }, end: { line: 2, column: 9 } },
        },
        s: { "0": 0, "1": 3, "2": 0 },
      },
      "/w/empty.js": { path: "/w/empty.js", statementMap: {}, s: {} },
      "/w/odd.js": { path: "/w/odd.js", statementMap: "nope", s: null },
    });
    expect(Object.fromEntries(parseIstanbulJson(json))).toEqual({
      "/w/a.js": { lines: 2, covered: 1 },
    });
    expect(parseIstanbulJson("{not json").size).toBe(0);
    expect(parseIstanbulJson("[1,2]").size).toBe(0);
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
