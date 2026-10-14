import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Graph, serializeCanonical } from "@epoch-dev/core";
import { analyze } from "@epoch-dev/engine";
import { EXIT_ERROR, EXIT_OK, run } from "./run.js";

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
