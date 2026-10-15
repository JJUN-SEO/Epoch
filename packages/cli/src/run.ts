import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { serializeCanonical, type Progress } from "@epoch-dev/core";
import {
  DEFAULT_MAX_CACHE_BYTES,
  ParsePool,
  analyze,
  changedSince,
  openCache,
  type SqliteCacheStore,
} from "@epoch-dev/engine";
import { formatSummary } from "./summary.js";

/** Where the CLI writes; the real bin passes process.stdout and process.stderr. */
export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown; isTTY?: boolean };
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;

const MIB = 1024 * 1024;

export const USAGE = `Usage:
  epoch analyze <path> [--json] [--since <commit>]
  epoch cache stats | clear | prune [--max-size <MB>]

Commands:
  analyze <path>   Build the dependency graph of a project folder (read-only)
  cache stats      Show where the cache is and what it holds
  cache clear      Delete everything in the cache (it is derived data)
  cache prune      Evict least-recently-used entries down to --max-size

Options:
  --json             Print the canonical graph as JSON on stdout
  --since <commit>   Also re-read files changed between <commit> and HEAD
  --max-size <MB>    Cache size cap for prune (default ${String(DEFAULT_MAX_CACHE_BYTES / MIB)})
  -h, --help         Show this help

The cache lives in the per-user cache directory; set EPOCH_CACHE_DIR to move it.
`;

class UsageError extends Error {}

/** Our own usage errors and node:util parseArgs rejections (unknown option, extra positional). */
function isUsageError(err: unknown): boolean {
  if (err instanceof UsageError) return true;
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? err.code
      : undefined;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS_");
}

function progressReporter(stderr: CliIo["stderr"]): (p: Progress) => void {
  let lastStage: Progress["stage"] | undefined;
  return (p) => {
    if (p.stage === "done") {
      if (stderr.isTTY) stderr.write("\r\x1b[K");
      return;
    }
    if (stderr.isTTY) {
      stderr.write(`\r\x1b[K${p.stage} ${String(p.done)}/${String(p.total)}`);
    } else if (p.stage !== lastStage) {
      stderr.write(`${p.stage}...\n`);
    }
    lastStage = p.stage;
  };
}

async function analyzeCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      json: { type: "boolean", default: false },
      since: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new UsageError("analyze needs exactly one <path>");
  }
  const target = path.resolve(positionals[0]);
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`not a directory: ${positionals[0]}`);

  const forceReread =
    values.since === undefined
      ? undefined
      : new Set(changedSince(target, values.since));

  let cache: SqliteCacheStore | undefined;
  try {
    cache = openCache();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(
      `epoch: cache unavailable (${message}); analyzing without it\n`,
    );
  }
  // Workers start only for a large batch of cache misses (DEFAULT_MIN_BATCH).
  const pool = new ParsePool();
  let result: Awaited<ReturnType<typeof analyze>>;
  try {
    result = await analyze(target, {
      onProgress: progressReporter(io.stderr),
      pool,
      ...(cache ? { cache } : {}),
      ...(forceReread ? { forceReread } : {}),
    });
    cache?.prune(DEFAULT_MAX_CACHE_BYTES);
  } finally {
    cache?.close();
    await pool.destroy();
  }
  const { graph, meta } = result;
  if (values.json) {
    // stdout carries only the canonical, schema-validated Graph.
    io.stdout.write(serializeCanonical(graph));
    io.stderr.write(formatSummary(graph, meta));
  } else {
    io.stdout.write(formatSummary(graph, meta));
  }
  return EXIT_OK;
}

function cacheCommand(args: readonly string[], io: CliIo): number {
  const [sub, ...rest] = args;
  // strict parsing rejects unknown options and stray positionals
  const { values } = parseArgs({
    args: rest,
    options: { "max-size": { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  if (sub !== "stats" && sub !== "clear" && sub !== "prune") {
    throw new UsageError(
      sub === undefined
        ? "cache needs stats, clear or prune"
        : `unknown cache command: ${sub}`,
    );
  }
  if (values["max-size"] !== undefined && sub !== "prune") {
    throw new UsageError("--max-size only applies to cache prune");
  }
  const cache = openCache();
  try {
    if (sub === "stats") {
      const s = cache.stats();
      io.stdout.write(
        [
          `Cache: ${s.location ?? "(memory)"}`,
          `  size on disk   ${(s.bytes / MIB).toFixed(1)} MB`,
          `  facts          ${String(s.facts)}`,
          `  repos          ${String(s.repos)}`,
          `  manifest       ${String(s.manifestEntries)}`,
          `  derived        ${String(s.derived)}`,
          "",
        ].join("\n"),
      );
    } else if (sub === "clear") {
      cache.clear();
      io.stdout.write(`Cleared ${cache.file}\n`);
    } else {
      const raw = values["max-size"];
      const mb =
        raw === undefined ? DEFAULT_MAX_CACHE_BYTES / MIB : Number(raw);
      if (!Number.isFinite(mb) || mb < 0)
        throw new UsageError(
          `--max-size must be a number of MB, got ${String(raw)}`,
        );
      const removed = cache.prune(mb * MIB);
      io.stdout.write(
        `Removed ${String(removed)} entries (cap ${String(mb)} MB)\n`,
      );
    }
  } finally {
    cache.close();
  }
  return EXIT_OK;
}

/**
 * The `epoch` command line. Returns the exit code instead of exiting, so it
 * can be tested in-process. Progress, warnings and errors go to stderr;
 * with --json, stdout holds nothing but the graph.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "-h" || command === "--help" || command === "help") {
      io.stdout.write(USAGE);
      return EXIT_OK;
    }
    if (command === "analyze") return await analyzeCommand(rest, io);
    if (command === "cache") return cacheCommand(rest, io);
    throw new UsageError(
      command === undefined ? "missing command" : `unknown command: ${command}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(`epoch: ${message}\n`);
    if (isUsageError(err)) io.stderr.write(`\n${USAGE}`);
    return EXIT_ERROR;
  }
}
