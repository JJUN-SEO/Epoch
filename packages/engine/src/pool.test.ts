import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { serializeCanonical } from "@epoch-dev/core";
import { analyze } from "./analyze.js";
import { MemoryCacheStore } from "./cache/memory-store.js";
import { ParsePool } from "./pool.js";

// Workers load the built module (pnpm test builds first; turbo.json).
const workerFile = new URL("../dist/parse-worker.js", import.meta.url);
const fixtures = fileURLToPath(
  new URL("../../../fixtures/typescript/", import.meta.url),
);
const conformance = ["typescript", "python"].flatMap((language) => {
  const dir = fileURLToPath(
    new URL(`../../../fixtures/${language}/conformance/`, import.meta.url),
  );
  return fs.readdirSync(dir).map((name) => `${dir}${name}`);
});

// batchSize 2 exercises several batches per fixture.
const pool = new ParsePool({
  threads: 2,
  minBatch: 1,
  batchSize: 2,
  workerFile,
});

afterAll(async () => {
  await pool.destroy();
});

describe("ParsePool", () => {
  it.each([...conformance, `${fixtures}monorepo`, `${fixtures}safety`])(
    "produces the same graph and cached facts as in-process parsing: %s",
    async (dir) => {
      const inProcessCache = new MemoryCacheStore();
      const pooledCache = new MemoryCacheStore();
      const inProcess = await analyze(dir, { cache: inProcessCache });
      const pooled = await analyze(dir, { cache: pooledCache, pool });
      expect(serializeCanonical(pooled.graph)).toBe(
        serializeCanonical(inProcess.graph),
      );
      expect(pooled.meta.counts).toEqual(inProcess.meta.counts);
      // A warm run over the pool's cache finds every file it cached.
      const warm = await analyze(dir, { cache: pooledCache });
      expect(warm.meta.counts.cacheMisses).toBe(0);
      expect(serializeCanonical(warm.graph)).toBe(
        serializeCanonical(inProcess.graph),
      );
    },
  );

  it("parses a batch under minBatch in-process, starting no worker", async () => {
    const lazy = new ParsePool({ threads: 2, minBatch: 64, workerFile });
    await analyze(`${fixtures}conformance/relative`, { pool: lazy });
    expect(lazy.started).toBe(false);
    await lazy.destroy();
  });

  it("surfaces a worker failure as a failed analysis", async () => {
    const broken = new ParsePool({
      threads: 1,
      minBatch: 1,
      workerFile: new URL("./does-not-exist.js", workerFile),
    });
    await expect(
      analyze(`${fixtures}conformance/relative`, { pool: broken }),
    ).rejects.toThrow();
    await broken.destroy();
  });
});

describe("EXTRACTORS", () => {
  it("has exactly the built-in adapters' extract functions", async () => {
    const { EXTRACTORS } = await import("./extractors.js");
    const { DEFAULT_REGISTRATIONS } = await import("./registrations.js");
    expect(Object.keys(EXTRACTORS).sort()).toEqual(
      DEFAULT_REGISTRATIONS.map((r) => r.adapter.id).sort(),
    );
    for (const r of DEFAULT_REGISTRATIONS) {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- identity check only; never called
      expect(EXTRACTORS[r.adapter.id]).toBe(r.adapter.extract);
    }
  });
});
