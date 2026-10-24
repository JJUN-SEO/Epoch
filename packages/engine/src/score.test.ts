import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeCanonical, type GraphNode } from "@epoch-dev/core";
import { analyze } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { toPosix } from "./discover.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const HEAD_TIME = 1_780_000_000;
const DAY = 86_400;

function project(files: Record<string, string>): string {
  const dir = toPosix(
    fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-score-")),
    ),
  );
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function commitAll(dir: string, message: string, daysBeforeHead: number): void {
  const when = `${String(HEAD_TIME - daysBeforeHead * DAY)} +0000`;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
  };
  childProcess.execFileSync("git", ["add", "-A"], { cwd: dir, env });
  childProcess.execFileSync(
    "git",
    ["commit", "-q", "--no-gpg-sign", "-m", message],
    {
      cwd: dir,
      env,
    },
  );
}

const FILES = {
  "src/core.ts": "export const core = 1;\n",
  "src/a.ts": 'import { core } from "./core";\nexport const a = core;\n',
  "src/b.ts": 'import { core } from "./core";\nexport const b = core;\n',
};

describe("the Score stage", () => {
  it("adds churn, coverage and risk in a git repository, and says what it used", async () => {
    const dir = project(FILES);
    childProcess.execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: dir,
    });
    commitAll(dir, "one", 30);
    fs.appendFileSync(path.join(dir, "src/a.ts"), "// more\n");
    commitAll(dir, "two", 0);
    fs.mkdirSync(path.join(dir, "coverage"));
    fs.writeFileSync(
      path.join(dir, "coverage/lcov.info"),
      `SF:${dir}/src/core.ts\nDA:1,1\nend_of_record\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n`,
    );

    const { graph, meta } = await analyze(dir);
    const metrics = Object.fromEntries(
      graph.nodes.map((n) => [n.id, n.metrics]),
    );
    expect(metrics["src/a.ts"]).toMatchObject({ churn90d: 2, coverage: 0.5 });
    expect(metrics["src/core.ts"]).toMatchObject({
      churn90d: 1,
      coverage: 1,
      fanIn: 2,
    });
    expect(metrics["src/b.ts"]?.coverage).toBeUndefined();
    // core.ts: 2 dependents (contained), 1 commit (warm), small and covered.
    expect(metrics["src/core.ts"]).toMatchObject({
      dependents: 2,
      risk: { tier: "low", archetype: "stable-leaf" },
    });
    for (const id of ["src/a.ts", "src/b.ts"]) {
      expect(metrics[id]?.risk).toEqual({
        tier: expect.any(String) as unknown,
        archetype: expect.any(String) as unknown,
      });
    }
    expect(meta.git).toMatchObject({
      status: "usable",
      shallow: false,
      churnUntil: HEAD_TIME,
      churnSince: HEAD_TIME - 90 * DAY,
    });
    expect(meta.coverage).toEqual({
      reports: [
        {
          source: "coverage/lcov.info",
          format: "lcov",
          files: 2,
          unmatched: 0,
          ambiguous: 0,
        },
      ],
    });

    // Incremental equals from scratch, history included.
    const cache = new MemoryCacheStore();
    await analyze(dir, { cache });
    const again = await analyze(dir, { cache });
    expect(serializeCanonical(again.graph)).toBe(serializeCanonical(graph));
  });

  it("gives no churn or risk outside a git repository, or with history off", async () => {
    const dir = project(FILES);
    const plain = await analyze(dir);
    expect(plain.meta.git).toEqual({ status: "not-a-repo" });
    expect(plain.graph.nodes.every((n) => n.metrics.risk === undefined)).toBe(
      true,
    );
    // Exposure is structure, not history: it is counted anyway.
    expect(
      plain.graph.nodes.find((n) => n.id === "src/core.ts")?.metrics.dependents,
    ).toBe(2);
    expect(plain.meta.coverage).toEqual({ reports: [] });
    const off = await analyze(dir, { history: false });
    expect(off.meta.git).toEqual({ status: "off" });
  });

  it("scores a Go package over its member files (ADR-013)", async () => {
    const dir = project({
      "go.mod": "module example.com/m\n",
      "p/a.go": "package p\n\nconst A = 1\n",
      "p/b.go": "package p\n\nconst B = 2\n",
      "p/p_test.go": "package p\n",
      "main.go": 'package main\n\nimport "example.com/m/p"\n\nvar _ = p.A\n',
    });
    childProcess.execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: dir,
    });
    commitAll(dir, "one", 20);
    fs.appendFileSync(path.join(dir, "p/a.go"), "// a\n");
    commitAll(dir, "two", 10);
    fs.appendFileSync(path.join(dir, "p/a.go"), "// a\n");
    fs.appendFileSync(path.join(dir, "p/b.go"), "// b\n");
    commitAll(dir, "three", 0);
    fs.writeFileSync(
      path.join(dir, "lcov.info"),
      "SF:p/a.go\nDA:3,1\nDA:4,0\nend_of_record\nSF:p/b.go\nDA:3,1\nend_of_record\n",
    );
    const { graph } = await analyze(dir);
    const pkg = graph.nodes.find((n) => n.id === "pkg:example.com/m/p");
    // Three distinct commits touched a.go or b.go; 2 of 3 lines are covered.
    expect(pkg?.metrics).toMatchObject({ churn90d: 3, fanIn: 2 });
    expect(pkg?.metrics.coverage).toBeCloseTo(2 / 3);
    // main.go and the package's test depend on it; three commits: hot, contained.
    expect(pkg?.metrics).toMatchObject({
      dependents: 2,
      risk: { tier: "moderate", archetype: "fragile-leaf" },
    });
  });

  it("uses a coverage report the caller names", async () => {
    const dir = project(FILES);
    const report = path.join(project({}), "cobertura.xml");
    fs.writeFileSync(
      report,
      `<coverage><sources><source>/ci/build/src</source></sources><packages><package><classes>
        <class filename="b.ts"><lines><line number="1" hits="3"/><line number="2" hits="3"/></lines></class>
      </classes></package></packages></coverage>`,
    );
    const { graph, meta } = await analyze(dir, { coverageFile: report });
    expect(graph.nodes.find((n) => n.id === "src/b.ts")?.metrics.coverage).toBe(
      1,
    );
    expect(meta.coverage.reports).toMatchObject([
      { source: report, format: "cobertura", files: 1 },
    ]);
  });
});

/** The profile go test wrote (fixtures/coverage-reports/README.md). */
const goProfile = fs.readFileSync(
  new URL("./fixtures/coverage-reports/go/coverage.out", import.meta.url),
  "utf8",
);

const WORKSPACE = {
  "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  "packages/a/package.json": JSON.stringify({ name: "a" }),
  "packages/a/src/math.ts": "export const one = 1;\n",
  "packages/b/package.json": JSON.stringify({ name: "b" }),
  "packages/b/src/math.ts": "export const two = 2;\n",
};

describe("coverage reports in the project (ADR-020)", () => {
  const coverageOf = (graph: { nodes: readonly GraphNode[] }, id: string) =>
    graph.nodes.find((n) => n.id === id)?.metrics.coverage;

  it("reads a package's own report, its relative paths inside that package", async () => {
    const dir = project({
      ...WORKSPACE,
      // vitest run in packages/a: paths relative to that folder.
      "packages/a/coverage/lcov.info":
        "SF:src/math.ts\nDA:1,1\nDA:2,0\nend_of_record\n",
      // Another reporter of the same run beside it: not read as well.
      "packages/a/coverage/clover.xml":
        '<coverage clover="3.2.0"><project><file name="math.ts" path="src/math.ts"><line num="1" count="0" type="stmt"/></file></project></coverage>',
    });
    const { graph, meta } = await analyze(dir, { history: false });
    expect(coverageOf(graph, "packages/a/src/math.ts")).toBe(0.5);
    expect(coverageOf(graph, "packages/b/src/math.ts")).toBeUndefined();
    expect(meta.coverage).toEqual({
      reports: [
        {
          source: "packages/a/coverage/lcov.info",
          format: "lcov",
          files: 1,
          unmatched: 0,
          ambiguous: 0,
        },
      ],
    });
  });

  it("takes each file from the most specific report, never from two", async () => {
    const dir = project({
      ...WORKSPACE,
      "src/root.ts": "export const r = 0;\n",
      // A merged report at the root covers the package file too...
      "coverage/lcov.info":
        "SF:packages/a/src/math.ts\nDA:1,0\nend_of_record\nSF:src/root.ts\nDA:1,1\nend_of_record\n",
      // ...and the package's own report wins for it.
      "packages/a/coverage/lcov.info":
        "SF:src/math.ts\nDA:1,1\nend_of_record\n",
    });
    const { graph, meta } = await analyze(dir, { history: false });
    expect(coverageOf(graph, "packages/a/src/math.ts")).toBe(1);
    expect(coverageOf(graph, "src/root.ts")).toBe(1);
    expect(meta.coverage.reports.map((r) => [r.source, r.files])).toEqual([
      ["packages/a/coverage/lcov.info", 1],
      ["coverage/lcov.info", 1],
    ]);
  });

  it("reads a Go profile through the module that owns each import path", async () => {
    const dir = project({
      "go/go.mod": "module example.com/covgo\n\ngo 1.24\n",
      "go/calc/calc.go":
        "package calc\n\nfunc Add(a, b int) int {\n\treturn a + b\n}\n",
      "go/internal/util/util.go":
        "package util\n\nfunc Shout(s string) string {\n\treturn s\n}\n",
      "go/cover.out": goProfile,
    });
    const { graph, meta } = await analyze(dir, { history: false });
    expect(coverageOf(graph, "pkg:example.com/covgo/calc")).toBe(0.5);
    expect(coverageOf(graph, "pkg:example.com/covgo/internal/util")).toBe(0);
    expect(meta.coverage.reports).toEqual([
      {
        source: "go/cover.out",
        format: "go",
        files: 2,
        unmatched: 0,
        ambiguous: 0,
      },
    ]);
  });

  it("uses the report chosen in the app instead, and says why it could not", async () => {
    const dir = project({
      ...FILES,
      "reports/unit.lcov": "SF:src/b.ts\nDA:1,1\nend_of_record\n",
      "coverage/lcov.info": "SF:src/a.ts\nDA:1,1\nend_of_record\n",
      "notes.txt": "hello\n",
    });
    const chosen = await analyze(dir, {
      history: false,
      coverageReport: "reports/unit.lcov",
    });
    expect(coverageOf(chosen.graph, "src/b.ts")).toBe(1);
    expect(coverageOf(chosen.graph, "src/a.ts")).toBeUndefined();
    expect(chosen.meta.coverage).toEqual({
      reports: [
        {
          source: "reports/unit.lcov",
          format: "lcov",
          files: 1,
          unmatched: 0,
          ambiguous: 0,
        },
      ],
      chosen: { path: "reports/unit.lcov" },
    });
    expect(chosen.coveragePaths).toEqual(["reports/unit.lcov"]);

    for (const [path, problem] of [
      ["reports/gone.lcov", "missing"],
      ["notes.txt", "unrecognized"],
      ["../outside.lcov", "missing"],
    ] as const) {
      const { graph, meta } = await analyze(dir, {
        history: false,
        coverageReport: path,
      });
      expect(meta.coverage).toEqual({ reports: [], chosen: { path, problem } });
      expect(coverageOf(graph, "src/a.ts")).toBeUndefined();
    }
  });

  it("lists the report paths it looked at, in every project folder", async () => {
    const { coveragePaths } = await analyze(project(WORKSPACE), {
      history: false,
    });
    for (const p of [
      "coverage/lcov.info",
      "coverage.xml",
      "cover.out",
      "packages/a/coverage/coverage-final.json",
      "packages/b/coverage/clover.xml",
      "packages/b/lcov.info",
    ])
      expect(coveragePaths).toContain(p);
  });
});
