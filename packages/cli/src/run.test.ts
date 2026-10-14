import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Graph, serializeCanonical } from "@epoch-dev/core";
import { analyze } from "@epoch-dev/engine";
import { EXIT_ERROR, EXIT_OK, run } from "./run.js";

// Every CLI run in this file uses a throwaway cache, never the user's.
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-cache-"));
process.env.EPOCH_CACHE_DIR = cacheDir;
afterAll(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const monorepo = fileURLToPath(
  new URL("../../../fixtures/typescript/monorepo/", import.meta.url),
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
  });
});

describe("epoch errors", () => {
  it.each([
    [[], "missing command"],
    [["frobnicate"], "unknown command: frobnicate"],
    [["analyze"], "analyze needs exactly one <path>"],
    [["analyze", monorepo, "--nope"], "Unknown option"],
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
