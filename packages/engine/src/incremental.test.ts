import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import type { Tree } from "web-tree-sitter";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeLine,
  serializeCanonical,
  sourceLines,
  type AdapterRegistration,
  type CacheStore,
} from "@epoch-dev/core";
import { typescriptRegistration } from "@epoch-dev/adapter-typescript";
import { analyze } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { CACHE_FILE, SqliteCacheStore } from "./cache/sqlite-store.js";

const FIXTURES = fileURLToPath(
  new URL("../../../fixtures/typescript/", import.meta.url),
);
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

const dirs: string[] = [];
const stores: CacheStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tempDir = (label: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `epoch-${label}-`));
  dirs.push(d);
  return d;
};
const copyFixture = (name: string) => {
  const dir = tempDir("project");
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
};
const sqlite = () => {
  const s = SqliteCacheStore.open(tempDir("cache"));
  stores.push(s);
  return s;
};
const canonical = async (dir: string, cache?: CacheStore) =>
  serializeCanonical((await analyze(dir, cache ? { cache } : {})).graph);

describe("incremental analysis (PLAN.md M2 acceptance)", () => {
  it.each([
    ["memory", () => new MemoryCacheStore()],
    ["sqlite", sqlite],
  ])(
    "re-running on unchanged input is a 100%% FileFacts cache hit (%s)",
    async (_n, make) => {
      const dir = path.join(FIXTURES, "monorepo");
      const cache = make();
      const first = await analyze(dir, { cache });
      const second = await analyze(dir, { cache });
      expect(first.meta.counts.cacheMisses).toBe(
        first.meta.counts.filesAnalyzed,
      );
      expect(second.meta.counts.cacheMisses).toBe(0);
      expect(second.meta.counts.cacheHits).toBe(
        second.meta.counts.filesAnalyzed,
      );
      expect(serializeCanonical(second.graph)).toBe(
        serializeCanonical(first.graph),
      );
      expect(serializeCanonical(second.graph)).toBe(await canonical(dir));
    },
  );

  it("trusts the manifest for files untouched since well before the last scan", async () => {
    const dir = copyFixture("monorepo");
    await new Promise((r) => setTimeout(r, 2_100)); // past the racy margin
    const cache = new MemoryCacheStore();
    await analyze(dir, { cache });
    const warm = await analyze(dir, { cache });
    expect(warm.meta.counts.rehashed).toBe(0);
    fs.appendFileSync(
      path.join(dir, "packages/core/src/math.ts"),
      "\nexport const added = 1;\n",
    );
    const edited = await analyze(dir, { cache });
    expect(edited.meta.counts.rehashed).toBe(1);
    expect(edited.meta.counts.cacheMisses).toBe(1);
    expect(serializeCanonical(edited.graph)).toBe(await canonical(dir));
  }, 20_000);

  it("re-reads an evicted entry and keys it by the bytes actually read", async () => {
    const dir = path.join(FIXTURES, "monorepo");
    const cache = new MemoryCacheStore();
    const first = await analyze(dir, { cache });
    cache.prune(0);
    const again = await analyze(dir, { cache });
    expect(again.meta.counts.cacheMisses).toBe(first.meta.counts.filesAnalyzed);
    expect(serializeCanonical(again.graph)).toBe(
      serializeCanonical(first.graph),
    );
  });

  it("never serves facts across an adapter version bump", async () => {
    const dir = path.join(FIXTURES, "monorepo");
    const cache = new MemoryCacheStore();
    await analyze(dir, { cache });
    const bumped: AdapterRegistration<Tree> = {
      ...typescriptRegistration,
      adapter: { ...typescriptRegistration.adapter, version: "999" },
    };
    const after = await analyze(dir, { cache, registrations: [bumped] });
    expect(after.meta.counts.cacheHits).toBe(0);
  });

  it("keeps no file contents or code excerpts in the cache database", async () => {
    const cacheDir = tempDir("cache");
    const store = SqliteCacheStore.open(cacheDir);
    const projects = [
      ...fs
        .readdirSync(path.join(FIXTURES, "conformance"))
        .map((c) => path.join(FIXTURES, "conformance", c)),
      path.join(FIXTURES, "monorepo"),
      path.join(FIXTURES, "safety"),
    ];
    const lines = new Set<string>();
    for (const dir of projects) {
      await analyze(dir, { cache: store });
      for (const f of fs.readdirSync(dir, {
        recursive: true,
        encoding: "utf8",
      })) {
        if (!SOURCE.test(f)) continue;
        for (const line of sourceLines(
          fs.readFileSync(path.join(dir, f), "utf8"),
        ))
          lines.add(line);
      }
    }
    expect(store.stats().facts).toBeGreaterThan(0);
    store.close();
    const bytes = [CACHE_FILE, `${CACHE_FILE}-wal`]
      .map((f) => path.join(cacheDir, f))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f).toString("latin1"))
      .join("\n");
    // The same rule as the summary sanitizer (core source-lines.ts).
    const stored = normalizeLine(bytes);
    expect(lines.size).toBeGreaterThan(50);
    expect([...lines].filter((l) => stored.includes(l))).toEqual([]);
  });
});

/* ---------- equivalence property test (the key M2 correctness test) ---------- */

type Op =
  | { kind: "append" | "drop-import" | "delete" | "rename"; a: number }
  | { kind: "import" | "add"; a: number; b: number }
  | { kind: "toggle-alias" | "use-alias"; a: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constantFrom("append", "drop-import", "delete", "rename"),
    a: fc.nat(50),
  }),
  fc.record({
    kind: fc.constantFrom("import", "add"),
    a: fc.nat(50),
    b: fc.nat(50),
  }),
  fc.record({
    kind: fc.constantFrom("toggle-alias", "use-alias"),
    a: fc.nat(50),
  }),
);

function sources(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((f) => f.split(path.sep).join("/"))
    .filter((f) => SOURCE.test(f))
    .sort();
}

/** A specifier from `from` to `to`, extensionless for TS targets (bundler resolution). */
function specifier(from: string, to: string): string {
  let rel = path.posix.relative(path.posix.dirname(from), to);
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return /\.tsx?$/.test(to) ? rel.replace(/\.tsx?$/, "") : rel;
}

function apply(root: string, op: Op, n: number): void {
  const files = sources(root);
  const pick = (i: number) => files[i % files.length] ?? "";
  const abs = (rel: string) => path.join(root, rel);
  switch (op.kind) {
    case "append":
      fs.appendFileSync(
        abs(pick(op.a)),
        `\nexport const added${String(n)} = ${String(n)};\n`,
      );
      return;
    case "import": {
      const from = pick(op.a);
      const text = fs.readFileSync(abs(from), "utf8");
      fs.writeFileSync(
        abs(from),
        `import "${specifier(from, pick(op.b))}";\n${text}`,
      );
      return;
    }
    case "drop-import": {
      const from = pick(op.a);
      const lines = fs.readFileSync(abs(from), "utf8").split("\n");
      const i = lines.findIndex((l) => l.startsWith("import "));
      if (i >= 0) lines.splice(i, 1);
      fs.writeFileSync(abs(from), lines.join("\n"));
      return;
    }
    case "add": {
      const rel = `${path.posix.dirname(pick(op.a))}/gen${String(n)}.ts`;
      fs.writeFileSync(
        abs(rel),
        `import "${specifier(rel, pick(op.b))}";\nexport const gen${String(n)} = 1;\n`,
      );
      return;
    }
    case "delete":
      if (files.length > 3) fs.rmSync(abs(pick(op.a)));
      return;
    case "rename": {
      const from = pick(op.a);
      fs.renameSync(
        abs(from),
        abs(
          `${path.posix.dirname(from)}/renamed${String(n)}${path.posix.extname(from)}`,
        ),
      );
      return;
    }
    case "toggle-alias": {
      const file = abs("apps/web/tsconfig.json");
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as {
        compilerOptions: Record<string, unknown>;
      };
      if ("paths" in cfg.compilerOptions) delete cfg.compilerOptions.paths;
      else
        cfg.compilerOptions.paths = { "@gen/*": ["../../packages/core/src/*"] };
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
      return;
    }
    case "use-alias": {
      const web = files.filter((f) => f.startsWith("apps/web/src/"));
      const from = web[op.a % Math.max(web.length, 1)];
      if (from === undefined) return;
      const text = fs.readFileSync(abs(from), "utf8");
      fs.writeFileSync(abs(from), `import "@gen/math";\n${text}`);
      return;
    }
  }
}

describe("equivalence property (PLAN.md M2): incremental == full recompute", () => {
  const runs = Number(process.env.EPOCH_PROPERTY_RUNS ?? "20");

  it("for random edit sequences (modify, add, delete, rename, tsconfig)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 6 }),
        async (ops) => {
          const dir = copyFixture("monorepo");
          const cache = new MemoryCacheStore();
          try {
            await analyze(dir, { cache });
            for (const [n, op] of ops.entries()) {
              apply(dir, op, n);
              await analyze(dir, { cache });
            }
            const incremental = serializeCanonical(
              (await analyze(dir, { cache })).graph,
            );
            expect(incremental).toBe(await canonical(dir));
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: runs },
    );
  }, 180_000);
});
