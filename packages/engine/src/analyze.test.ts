import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisMeta, Graph, serializeCanonical } from "@epoch-dev/core";
import { analyze } from "./analyze.js";

const fixture = (name: string): string =>
  fileURLToPath(
    new URL(`../../../fixtures/typescript/${name}/`, import.meta.url),
  );

/** sha256 of every file under dir, keyed by relative path. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        out.set(
          path.relative(dir, p),
          createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
        );
    }
  };
  walk(dir);
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("analyze: safety (CLAUDE.md principles 2 and 8)", () => {
  it("never executes project code or config and never writes into the project", async () => {
    const dir = fixture("safety");
    const before = snapshot(dir);
    const inside = (p: unknown) =>
      typeof p === "string" && path.resolve(p).startsWith(path.resolve(dir));
    const writes = [
      vi.spyOn(fs, "writeFileSync"),
      vi.spyOn(fs, "appendFileSync"),
      vi.spyOn(fs, "mkdirSync"),
      vi.spyOn(fs, "rmSync"),
      vi.spyOn(fs, "unlinkSync"),
      vi.spyOn(fs, "renameSync"),
    ];
    const spawns = [
      vi.spyOn(childProcess, "spawn"),
      vi.spyOn(childProcess, "spawnSync"),
      vi.spyOn(childProcess, "exec"),
      vi.spyOn(childProcess, "execSync"),
      vi.spyOn(childProcess, "execFile"),
      vi.spyOn(childProcess, "execFileSync"),
      vi.spyOn(childProcess, "fork"),
    ];

    const { graph } = await analyze(dir);

    for (const spy of writes) {
      expect(spy.mock.calls.filter(([p]) => inside(p))).toEqual([]);
    }
    for (const spy of spawns) expect(spy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "PWNED"))).toBe(false);
    expect(snapshot(dir)).toEqual(before);
    // The project is still analyzed: the require of evil.js is just an edge.
    expect(graph.edges.map((e) => `${e.source}>${e.target}`)).toEqual([
      "src/index.ts>evil.js",
      "src/index.ts>src/util.ts",
    ]);
  });
});

describe("analyze: monorepo fixture", async () => {
  const dir = fixture("monorepo");
  const before = snapshot(dir);
  const first = await analyze(dir);
  const second = await analyze(dir);

  it("produces a schema-valid graph and metadata", () => {
    expect(() => Graph.parse(first.graph)).not.toThrow();
    expect(() => AnalysisMeta.parse(first.meta)).not.toThrow();
  });

  it("is deterministic across runs", () => {
    expect(serializeCanonical(second.graph)).toBe(
      serializeCanonical(first.graph),
    );
  });

  it("leaves the analyzed project untouched", () => {
    expect(snapshot(dir)).toEqual(before);
  });

  it("links workspaces, barrels, assets and plain JS", () => {
    const edges = new Set(
      first.graph.edges.map((e) => `${e.source} -> ${e.target} : ${e.kind}`),
    );
    for (const expected of [
      "apps/web/src/main.tsx -> packages/core/src/math.ts : import",
      "apps/web/src/main.tsx -> packages/core/src/format.ts : import",
      "apps/web/src/main.tsx -> packages/core/src/index.ts : via-barrel",
      "apps/web/src/main.tsx -> packages/data/src/index.ts : import",
      "apps/web/src/main.tsx -> apps/web/src/types.ts : type-only",
      "apps/web/src/main.tsx -> apps/web/src/styles.css : import",
      "apps/web/src/main.tsx -> apps/web/src/routes/home.tsx : dynamic-import",
      "packages/data/src/index.ts -> packages/data/src/seed.json : import",
      "tools/build.mjs -> tools/helpers.cjs : import",
    ]) {
      expect(edges, expected).toContain(expected);
    }
    const byId = new Map(first.graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("apps/web/src/styles.css")?.language).toBe("css");
    expect(byId.get("apps/web/src/main.tsx")?.externals).toEqual(["react"]);
    expect(byId.get("tools/helpers.cjs")?.externals).toEqual(["node:path"]);
    expect(first.graph.unresolved).toEqual([
      {
        from: "apps/web/src/main.tsx",
        specifier: null,
        reason: "dynamic-specifier",
        pathPrefix: "apps/web/src/routes/",
        line: 8,
      },
    ]);
  });

  it("reports counts and cycles in the metadata", () => {
    expect(first.meta.counts.nodes).toBe(first.graph.nodes.length);
    expect(first.meta.counts.edges).toBe(first.graph.edges.length);
    expect(first.meta.cycles).toEqual([]);
    expect(first.meta.adapters).toEqual([
      { id: "typescript", version: "1", tier: "A" },
    ]);
  });
});
