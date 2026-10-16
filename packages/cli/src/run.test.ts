import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Graph, serializeCanonical } from "@epoch-dev/core";
import { DismissalStore, analyze } from "@epoch-dev/engine";
import { EXIT_ERROR, EXIT_FINDINGS, EXIT_OK, run } from "./run.js";

// Every CLI run in this file uses a throwaway cache, never the user's.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-cache-"));
process.env.EPOCH_CACHE_DIR = cacheDir;
afterAll(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const monorepo = fileURLToPath(
  new URL("../../../fixtures/typescript/monorepo/", import.meta.url),
);
// The engine's tiny test model: the runtime path without a real model.
const tinyModel = fileURLToPath(
  new URL("../../engine/src/fixtures/tiny-embedder/", import.meta.url),
);

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { code, stdout, stderr };
}

describe("epoch analyze --json", async () => {
  const first = await cli("analyze", monorepo, "--json");
  const second = await cli("analyze", monorepo, "--json");

  it("exits 0 and prints only the canonical, schema-valid graph on stdout", async () => {
    expect(first.code).toBe(EXIT_OK);
    const graph = Graph.parse(JSON.parse(first.stdout));
    expect(first.stdout).toBe(serializeCanonical(graph));
    expect(first.stdout).toBe(
      serializeCanonical((await analyze(monorepo)).graph),
    );
  });

  it("includes the unresolved list with reasons", () => {
    const graph = Graph.parse(JSON.parse(first.stdout));
    expect(graph.unresolved.map((u) => u.reason)).toEqual([
      "dynamic-specifier",
    ]);
  });

  it("puts progress and the summary on stderr", () => {
    expect(first.stderr).toContain("parse...");
    expect(first.stderr).toMatch(/nodes\s+\d+/);
    expect(first.stderr).not.toContain('"schemaVersion"');
  });

  it("never prints absolute paths in the graph", () => {
    expect(first.stdout).not.toContain(
      monorepo.replaceAll("\\", "/").replace(/\/$/, ""),
    );
  });

  it("serves the second run from the cache", () => {
    expect(first.stderr).toMatch(/cache hits\s+0\n/);
    expect(second.stderr).toMatch(/parsed\s+0\n/);
  });

  it("is byte-identical across runs", () => {
    expect(second.stdout).toBe(first.stdout);
  });
});

describe("epoch analyze (human summary)", () => {
  it("prints counts and the unresolved imports", async () => {
    const r = await cli("analyze", monorepo);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toMatch(/^Analyzed \d+ files in /);
    expect(r.stdout).toContain("unresolved");
    expect(r.stdout).toContain(
      "apps/web/src/main.tsx:8  <non-literal>  dynamic-specifier under apps/web/src/routes/",
    );
    // The fixture is not a git repository root, and has no coverage report.
    expect(r.stdout).toContain(
      "git          no churn or risk tiers (not-a-repo)",
    );
    expect(r.stdout).toContain("coverage     none found");
    expect(r.stdout).toMatch(
      /hints {8}\d+ likely relations \(heuristic scorer\): no co-change \(not-a-repo\), shared strings \d+ pairs/,
    );
  });

  it("adds similarity hints from a local embedding model folder", async () => {
    const r = await cli("analyze", monorepo, "--embedding-model", tinyModel);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toMatch(
      /shared strings \d+ pairs, similarity \d+ pairs \(tiny-embedder@000000000000\)/,
    );
  });

  it("counts files per risk tier in a git repository (ADR-015)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-risk-"));
    try {
      fs.mkdirSync(path.join(dir, "src"));
      fs.writeFileSync(path.join(dir, "src/core.ts"), "export const c = 1;\n");
      fs.writeFileSync(
        path.join(dir, "src/a.ts"),
        'import { c } from "./core";\nexport const a = c;\n',
      );
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "user.email=t@example.com",
            "-c",
            "user.name=t",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: dir, stdio: "pipe" },
        );
      git("init", "-q", "-b", "main");
      git("add", "-A");
      git("commit", "-q", "-m", "one");
      const r = await cli("analyze", dir, "--no-hints");
      expect(r.code).toBe(EXIT_OK);
      // Two small files, one dependent, one commit each: both stable leaves.
      expect(r.stdout).toContain(
        "risk tiers   0 critical, 0 high, 0 moderate, 0 low-moderate, 2 low",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips hint edges with --no-hints", async () => {
    const r = await cli("analyze", monorepo, "--no-hints");
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain("hints        off");
  });

  it("uses the coverage report given with --coverage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-cov-"));
    try {
      const report = path.join(dir, "lcov.info");
      fs.writeFileSync(
        report,
        "SF:/ci/work/apps/web/src/main.tsx\nDA:1,1\nDA:2,0\nend_of_record\nSF:/elsewhere/x.ts\nDA:1,1\nend_of_record\n",
      );
      const r = await cli("analyze", monorepo, "--coverage", report);
      expect(r.code).toBe(EXIT_OK);
      expect(r.stdout).toContain(
        `coverage     ${report} (lcov): 1 files, 1 unmatched, 0 ambiguous`,
      );
      const json = await cli(
        "analyze",
        monorepo,
        "--json",
        "--coverage",
        report,
      );
      const graph = Graph.parse(JSON.parse(json.stdout));
      expect(
        graph.nodes.find((n) => n.id === "apps/web/src/main.tsx")?.metrics
          .coverage,
      ).toBe(0.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("epoch errors", () => {
  it.each([
    [[], "missing command"],
    [["frobnicate"], "unknown command: frobnicate"],
    [["analyze"], "analyze needs exactly one <path>"],
    [["analyze", monorepo, "--nope"], "Unknown option"],
    [
      ["analyze", monorepo, "--cochange-days", "0"],
      "--cochange-days must be a positive whole number, got 0",
    ],
    [
      ["findings", monorepo, "--no-hints", "--cochange-min-support", "2"],
      "--no-hints cannot be combined with --cochange-*",
    ],
    [
      ["analyze", monorepo, "--no-hints", "--embedding-model", "models/x"],
      "--no-hints cannot be combined with --cochange-*, --embedding-model",
    ],
    [
      ["analyze", monorepo, "--embedding-model", monorepo],
      "--embedding-model: no embedding model in",
    ],
  ])("exits 1 with usage for %j", async (argv, message) => {
    const r = await cli(...argv);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(message);
    expect(r.stderr).toContain("Usage:");
  });

  it("exits 1 when the path is not a directory", async () => {
    const r = await cli("analyze", "definitely/not/here", "--json");
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("epoch: not a directory: definitely/not/here\n");
  });

  it("prints help on stdout", async () => {
    const r = await cli("--help");
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain("epoch analyze <path> [--json]");
  });
});

describe("the built bin", () => {
  it("runs in plain Node and keeps stdout pure JSON", () => {
    const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const stdout = execFileSync(
      process.execPath,
      [bin, "analyze", monorepo, "--json"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(() => Graph.parse(JSON.parse(stdout))).not.toThrow();
  });
});

describe("epoch analyze --since", () => {
  it("accepts a commit and rejects unknown ones", async () => {
    const ok = await cli("analyze", monorepo, "--json", "--since", "HEAD");
    expect(ok.code).toBe(EXIT_OK);
    const bad = await cli("analyze", monorepo, "--since", "no-such-commit-xyz");
    expect(bad.code).toBe(EXIT_ERROR);
    expect(bad.stderr).toContain("unknown commit");
    expect(bad.stdout).toBe("");
  });
});

describe("epoch cache", () => {
  it("reports, prunes and clears the cache", async () => {
    await cli("analyze", monorepo);
    const stats = await cli("cache", "stats");
    expect(stats.code).toBe(EXIT_OK);
    expect(stats.stdout).toContain(cacheDir);
    expect(stats.stdout).toMatch(/facts\s+[1-9]/);
    const pruned = await cli("cache", "prune", "--max-size", "0");
    expect(pruned.stdout).toMatch(/^Removed [1-9]\d* entries/);
    await cli("analyze", monorepo);
    const cleared = await cli("cache", "clear");
    expect(cleared.code).toBe(EXIT_OK);
    expect((await cli("cache", "stats")).stdout).toMatch(/facts\s+0\n/);
  });

  it.each([
    [["cache"], "cache needs stats, clear or prune"],
    [["cache", "nuke"], "unknown cache command: nuke"],
    [
      ["cache", "stats", "--max-size", "1"],
      "--max-size only applies to cache prune",
    ],
    [["cache", "prune", "--max-size", "lots"], "--max-size must be a number"],
  ])("exits 1 with usage for %j", async (argv, message) => {
    const r = await cli(...argv);
    expect(r.code).toBe(EXIT_ERROR);
    expect(r.stderr).toContain(message);
  });
});

describe("epoch findings", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-data-"));
  process.env.EPOCH_DATA_DIR = dataDir;
  afterAll(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const fixture = (name: string) =>
    fileURLToPath(
      new URL(
        `../../../fixtures/typescript/findings/${name}/`,
        import.meta.url,
      ),
    );

  it("lists candidates with hedged wording and exits 2 at --fail-on", async () => {
    const r = await cli(
      "findings",
      fixture("dead-branch-literal"),
      "--fail-on",
      "high",
    );
    expect(r.code).toBe(EXIT_FINDINGS);
    expect(r.stdout).toContain(
      "[Worth a look] Branch that likely never runs: src/index.ts",
    );
    expect(r.stdout).toContain("at src/index.ts:2-4");
    expect(r.stdout).toContain("These are candidates, not verdicts");
    expect(r.stdout).toContain("Not a git repository");
  });

  it("exits 0 when nothing reaches --fail-on, and 1 on a bad level", async () => {
    const none = await cli(
      "findings",
      fixture("dead-branch-reassigned"),
      "--fail-on",
      "low",
    );
    expect(none.code).toBe(EXIT_OK);
    expect(none.stdout).toContain("No findings to review at this level.");
    const bad = await cli(
      "findings",
      fixture("dead-branch-reassigned"),
      "--fail-on",
      "sure",
    );
    expect(bad.code).toBe(EXIT_ERROR);
    expect(bad.stderr).toContain("--fail-on must be high, medium or low");
  });

  it("hides findings below --min-confidence and says how many", async () => {
    // Outside a git repository the orphan is capped at Medium (history-unusable).
    const dir = fixture("unreachable-orphan");
    const shown = await cli("findings", dir);
    expect(shown.stdout).toContain(
      "[Maybe] Possibly unused file: src/orphan.ts",
    );
    expect(shown.stdout).toContain(
      "rated Maybe because git history was not available",
    );
    const hidden = await cli(
      "findings",
      dir,
      "--min-confidence",
      "high",
      "--json",
    );
    const out = JSON.parse(hidden.stdout) as {
      findings: unknown[];
      hidden: { belowMinConfidence: number };
      history: string;
    };
    expect(out.findings).toEqual([]);
    expect(out.hidden.belowMinConfidence).toBe(1);
    expect(out.history).toBe("not-a-repo");
  });

  it("leaves dismissed findings out unless asked, and they no longer fail the run", async () => {
    const dir = fixture("dead-branch-local-const");
    const { graph, root } = await analyze(dir, { history: false });
    const id = graph.findings[0]?.id;
    expect(id).toBeDefined();
    DismissalStore.forProject(root).dismiss(id ?? "", "on purpose");
    const r = await cli("findings", dir, "--fail-on", "high");
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain(
      "1 dismissed (use --include-dismissed to list them).",
    );
    const all = await cli(
      "findings",
      dir,
      "--fail-on",
      "high",
      "--include-dismissed",
      "--json",
    );
    expect(all.code).toBe(EXIT_FINDINGS);
    const out = JSON.parse(all.stdout) as {
      findings: { id: string; dismissed: boolean }[];
    };
    expect(out.findings).toEqual([
      expect.objectContaining({ id, dismissed: true }),
    ]);
  });
});
