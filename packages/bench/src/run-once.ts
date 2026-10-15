/**
 * One analysis in a fresh process, for `pnpm bench`: opens the cache from
 * EPOCH_CACHE_DIR, analyzes, serializes the canonical graph and prints the run
 * metadata as JSON. It runs as the CLI does, with a parse pool that starts
 * workers only for a large batch of cache misses; `--in-process` parses every
 * file in the main thread instead.
 */
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { serializeCanonical } from "@epoch-dev/core";
import {
  DEFAULT_MAX_CACHE_BYTES,
  ParsePool,
  analyze,
  openCache,
} from "@epoch-dev/engine";

const { values, positionals } = parseArgs({
  options: { "in-process": { type: "boolean", default: false } },
  allowPositionals: true,
});
const dir = positionals[0];
if (dir === undefined) throw new Error("usage: run-once <dir> [--in-process]");
const t0 = performance.now();
const cache = openCache();
const pool = values["in-process"] ? undefined : new ParsePool();
try {
  const { graph, meta } = await analyze(dir, {
    cache,
    ...(pool ? { pool } : {}),
  });
  const json = serializeCanonical(graph);
  cache.prune(DEFAULT_MAX_CACHE_BYTES);
  process.stdout.write(
    JSON.stringify({
      meta,
      graphBytes: json.length,
      inProcessMs: performance.now() - t0,
    }),
  );
} finally {
  cache.close();
  await pool?.destroy();
}
