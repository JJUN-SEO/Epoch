/**
 * One analysis in a fresh process, for `pnpm bench`: opens the cache from
 * EPOCH_CACHE_DIR, analyzes, serializes the canonical graph (as the CLI does)
 * and prints the run metadata as JSON.
 */
import { performance } from "node:perf_hooks";
import { serializeCanonical } from "@epoch-dev/core";
import { DEFAULT_MAX_CACHE_BYTES, analyze, openCache } from "@epoch-dev/engine";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: run-once <dir>");
const t0 = performance.now();
const cache = openCache();
try {
  const { graph, meta } = await analyze(dir, { cache });
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
}
