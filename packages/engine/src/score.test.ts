import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeCanonical } from "@epoch-dev/core";
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
    for (const id of ["src/a.ts", "src/b.ts", "src/core.ts"]) {
      expect(metrics[id]?.riskScore).toEqual(expect.any(Number));
    }
    expect(meta.git).toMatchObject({
      status: "usable",
      shallow: false,
      churnUntil: HEAD_TIME,
      churnSince: HEAD_TIME - 90 * DAY,
    });
    expect(meta.coverage).toEqual({
      source: "coverage/lcov.info",
      format: "lcov",
      files: 2,
      unmatched: 0,
      ambiguous: 0,
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
    expect(
      plain.graph.nodes.every((n) => n.metrics.riskScore === undefined),
    ).toBe(true);
    expect(plain.meta.coverage).toBeNull();
    const off = await analyze(dir, { history: false });
    expect(off.meta.git).toEqual({ status: "off" });
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
    expect(meta.coverage).toMatchObject({
      source: report,
      format: "cobertura",
      files: 1,
    });
  });
});
