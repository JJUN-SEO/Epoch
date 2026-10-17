import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  Confidence,
  HINT_DEFAULTS,
  atLeast,
  filterFindings,
  serializeCanonical,
  type Progress,
} from "@epoch-dev/core";
import {
  DEFAULT_MAX_CACHE_BYTES,
  DismissalStore,
  ParsePool,
  analyze,
  changedSince,
  localEmbedder,
  openCache,
  type AnalyzeOptions,
  type LocalEmbedder,
  type SqliteCacheStore,
} from "@epoch-dev/engine";
import {
  ConsentRequired,
  DEFAULT_LLM_MODEL,
  SCORER_ARGS,
  ScorerUsageError,
  type ScorerValues,
  installTripwire,
  type ScorerNetwork,
} from "@epoch-dev/scorers";
import {
  AuthUsageError,
  PROVIDERS,
  authCommand,
  osKeychain,
  resolveKey,
  type KeyInput,
  type Keychain,
} from "./auth.js";
import { formatFindings } from "./findings.js";
import { chooseScorer } from "./scorer.js";
import { formatSummary } from "./summary.js";

/** Where the CLI writes; the real bin passes process.stdout and process.stderr. */
export interface CliIo {
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown; isTTY?: boolean };
}

/** What a run reads besides its arguments; tests pass their own. */
export interface RunDeps {
  /** Where `epoch auth` stores keys (default: the OS keychain). */
  readonly keychain?: Keychain;
  /** Where `epoch auth set` reads a key (default: standard input). */
  readonly input?: KeyInput;
  /** Where model keys are looked up first (default: process.env). */
  readonly env?: NodeJS.ProcessEnv;
}

/** The io of one run, where its scorer's requests may go (--offline), and where its keys are. */
interface RunIo extends CliIo {
  readonly network: ScorerNetwork;
  readonly env: NodeJS.ProcessEnv;
  readonly keychain: Keychain;
}

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** `epoch findings --fail-on`: findings at or above the level remain. */
export const EXIT_FINDINGS = 2;

const MIB = 1024 * 1024;

export const USAGE = `Usage:
  epoch [--offline] <command> ...
  epoch analyze <path> [--json] [--since <commit>] [--coverage <file>]
                       [hint options]
  epoch findings <path> [--json] [--min-confidence <level>] [--fail-on <level>]
                        [--include-dismissed] [hint options]
  epoch cache stats | clear | prune [--max-size <MB>]
  epoch auth set | status | remove <provider>

Commands:
  analyze <path>   Build the dependency graph of a project folder (read-only)
  findings <path>  List likely-dead feature candidates for review: branches
                   that likely never run, possibly stale flags, possibly
                   unused files. Candidates, never verdicts
  cache stats      Show where the cache is and what it holds
  cache clear      Delete everything in the cache (it is derived data)
  cache prune      Evict least-recently-used entries down to --max-size
  auth set <provider>
                   Store your own key (provider: anthropic) in the OS
                   keychain; it is read from standard input (typed hidden,
                   or piped), never from the command line
  auth status      Show where each key is found, never the key; an
                   environment variable (ANTHROPIC_API_KEY) is used first
  auth remove <provider>
                   Delete a stored key from the OS keychain

Options:
  --offline          Turn the network off for this run; a model on this
                     machine (--scorer local) still works
  --json             Print the canonical graph as JSON on stdout
  --since <commit>   Also re-read files changed between <commit> and HEAD
  --coverage <file>  Use this lcov or Cobertura report (default: look for
                     coverage/lcov.info, coverage/cobertura-coverage.xml,
                     coverage.xml or lcov.info in the project)
  --min-confidence <level>
                     high, medium or low: the lowest level listed (default:
                     findings.minConfidence in epoch.config.json, else medium)
  --fail-on <level>  Exit 2 when a non-dismissed finding is at or above level
  --include-dismissed
                     Also list findings dismissed in the app
  --max-size <MB>    Cache size cap for prune (default ${String(DEFAULT_MAX_CACHE_BYTES / MIB)})
  -h, --help         Show this help

Hint options (likely relations, never facts; computed on this machine):
  --no-hints         Skip hint edges (co-change, shared strings, similarity)
  --cochange-days <n>
                     Co-change window before HEAD's commit (default ${String(HINT_DEFAULTS.cochange.days)})
  --cochange-max-files <n>
                     Skip commits touching more files than this (default ${String(HINT_DEFAULTS.cochange.maxFiles)})
  --cochange-min-support <n>
                     Commits a pair needs together (default ${String(HINT_DEFAULTS.cochange.minSupport)})
  --embedding-model <dir>
                     Similarity hints from a local embedding model folder
                     (scripts/fetch-model.mjs, or the one the app bundles);
                     runs on this machine, never downloads (default:
                     EPOCH_EMBEDDING_MODEL, else off)
  --scorer <name>    heuristic (default: no model, nothing leaves this machine);
                     local: an Ollama server on this machine (needs --model);
                     llm: Claude with your own key, from ANTHROPIC_API_KEY or
                     epoch auth (sends file excerpts to Anthropic; needs
                     --consent-send, --max-spend, --price-in, --price-out);
                     jev: not built yet
  --model <name>     The model for --scorer local or llm (llm default: ${DEFAULT_LLM_MODEL})
  --max-pairs <n>    Candidate pairs a model scores at most (default 200)
  --max-spend <USD>  Stop before a request could pass this spend (llm)
  --price-in <USD>, --price-out <USD>
                     Your model's prices per million input and output tokens
  --consent-send     Send what the plan printed without it lists (llm)

The cache lives in the per-user cache directory; set EPOCH_CACHE_DIR to move it.
Dismissals live in the per-user data directory; set EPOCH_DATA_DIR to move it.

Exit codes: 0 success, 1 error, 2 findings at or above --fail-on.
`;

class UsageError extends Error {}

/** Our own usage errors and node:util parseArgs rejections (unknown option, extra positional). */
function isUsageError(err: unknown): boolean {
  if (
    err instanceof UsageError ||
    err instanceof ScorerUsageError ||
    err instanceof AuthUsageError
  )
    return true;
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

/** A directory to analyze, from the single positional argument. */
function targetOf(command: string, positionals: readonly string[]): string {
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new UsageError(`${command} needs exactly one <path>`);
  }
  const target = path.resolve(positionals[0]);
  let isDir = false;
  try {
    isDir = fs.statSync(target).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) throw new Error(`not a directory: ${positionals[0]}`);
  return target;
}

const HINT_ARGS = {
  "no-hints": { type: "boolean", default: false },
  "cochange-days": { type: "string" },
  "cochange-max-files": { type: "string" },
  "cochange-min-support": { type: "string" },
  "embedding-model": { type: "string" },
  ...SCORER_ARGS,
} as const;

function positiveInt(option: string, raw: string | undefined) {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(
      `${option} must be a positive whole number, got ${raw}`,
    );
  }
  return n;
}

/** The embedding model folder from --embedding-model or EPOCH_EMBEDDING_MODEL, started only if a file needs a vector. */
function embedderOf(flag: string | undefined): LocalEmbedder | undefined {
  const raw = flag ?? process.env.EPOCH_EMBEDDING_MODEL;
  if (raw === undefined || raw === "") return undefined;
  const dir = path.resolve(raw);
  try {
    return localEmbedder(dir);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `${flag === undefined ? "EPOCH_EMBEDDING_MODEL" : "--embedding-model"}: no embedding model in ${dir} (${why.split("\n")[0] ?? why})`,
    );
  }
}

/** AnalyzeOptions.hints from the hint options, the model scorer's summary, and what to free afterwards. */
function hintsOf(
  values: ScorerValues & {
    "no-hints": boolean;
    "cochange-days"?: string | undefined;
    "cochange-max-files"?: string | undefined;
    "cochange-min-support"?: string | undefined;
    "embedding-model"?: string | undefined;
  },
  target: string,
  io: RunIo,
  env: NodeJS.ProcessEnv,
): {
  options: Pick<AnalyzeOptions, "hints">;
  summary: () => string | undefined;
  close: () => Promise<void>;
} {
  const days = positiveInt("--cochange-days", values["cochange-days"]);
  const maxFiles = positiveInt(
    "--cochange-max-files",
    values["cochange-max-files"],
  );
  const minSupport = positiveInt(
    "--cochange-min-support",
    values["cochange-min-support"],
  );
  if (values["no-hints"]) {
    if (
      days !== undefined ||
      maxFiles !== undefined ||
      minSupport !== undefined ||
      values.scorer !== "heuristic" ||
      values["embedding-model"] !== undefined
    )
      throw new UsageError(
        "--no-hints cannot be combined with --cochange-*, --embedding-model or --scorer",
      );
    return {
      options: { hints: false },
      summary: () => undefined,
      close: () => Promise.resolve(),
    };
  }
  const embedder = embedderOf(values["embedding-model"]);
  const chosen = chooseScorer(values, target, io.stderr, env, io.network);
  return {
    options: {
      hints: {
        cochange: {
          ...(days !== undefined ? { days } : {}),
          ...(maxFiles !== undefined ? { maxFiles } : {}),
          ...(minSupport !== undefined ? { minSupport } : {}),
        },
        ...(embedder ? { embeddings: { embedder } } : {}),
        ...(chosen.hints ? { scorer: chosen.hints } : {}),
      },
    },
    summary: chosen.summary,
    close: () => embedder?.close() ?? Promise.resolve(),
  };
}

/**
 * The environment a model scorer reads its key from: as it is, or with the
 * key from the OS keychain when it has none (ADR-009). The keychain is
 * opened only for a scorer that needs a key.
 */
async function scorerEnv(
  values: ScorerValues & { "no-hints": boolean },
  io: RunIo,
): Promise<NodeJS.ProcessEnv> {
  if (values.scorer !== "llm" || values["no-hints"]) return io.env;
  const key = await resolveKey("anthropic", io.env, io.keychain);
  if (key.value !== undefined)
    return { ...io.env, [PROVIDERS.anthropic.env]: key.value };
  if (key.unavailable !== undefined)
    io.stderr.write(
      `epoch: the OS keychain is not available (${key.unavailable})\n`,
    );
  return io.env;
}

/** Runs the engine with the shared cache and a worker pool, as the app does. */
async function analyzeWithCache(
  target: string,
  io: CliIo,
  opts: AnalyzeOptions,
): Promise<Awaited<ReturnType<typeof analyze>>> {
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
  try {
    const result = await analyze(target, {
      onProgress: progressReporter(io.stderr),
      pool,
      ...(cache ? { cache } : {}),
      ...opts,
    });
    cache?.prune(DEFAULT_MAX_CACHE_BYTES);
    return result;
  } finally {
    cache?.close();
    await pool.destroy();
  }
}

async function analyzeCommand(
  args: readonly string[],
  io: RunIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      json: { type: "boolean", default: false },
      since: { type: "string" },
      coverage: { type: "string" },
      ...HINT_ARGS,
    },
    allowPositionals: true,
    strict: true,
  });
  const target = targetOf("analyze", positionals);
  const forceReread =
    values.since === undefined
      ? undefined
      : new Set(changedSince(target, values.since));
  const hints = hintsOf(values, target, io, await scorerEnv(values, io));
  const { graph, meta } = await analyzeWithCache(target, io, {
    ...hints.options,
    ...(forceReread ? { forceReread } : {}),
    ...(values.coverage === undefined
      ? {}
      : { coverageFile: path.resolve(values.coverage) }),
  }).finally(hints.close);
  const scorerSummary = hints.summary();
  if (scorerSummary !== undefined) io.stderr.write(`${scorerSummary}\n`);
  if (values.json) {
    // stdout carries only the canonical, schema-validated Graph.
    io.stdout.write(serializeCanonical(graph));
    io.stderr.write(formatSummary(graph, meta));
  } else {
    io.stdout.write(formatSummary(graph, meta));
  }
  return EXIT_OK;
}

function level(
  option: string,
  raw: string | undefined,
): Confidence | undefined {
  if (raw === undefined) return undefined;
  const parsed = Confidence.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(`${option} must be high, medium or low, got ${raw}`);
  }
  return parsed.data;
}

async function findingsCommand(
  args: readonly string[],
  io: RunIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      json: { type: "boolean", default: false },
      "min-confidence": { type: "string" },
      "fail-on": { type: "string" },
      "include-dismissed": { type: "boolean", default: false },
      ...HINT_ARGS,
    },
    allowPositionals: true,
    strict: true,
  });
  const minFlag = level("--min-confidence", values["min-confidence"]);
  const failOn = level("--fail-on", values["fail-on"]);
  const target = targetOf("findings", positionals);
  const hints = hintsOf(values, target, io, await scorerEnv(values, io));
  const { root, config, graph, meta } = await analyzeWithCache(
    target,
    io,
    hints.options,
  ).finally(hints.close);
  const scorerSummary = hints.summary();
  if (scorerSummary !== undefined) io.stderr.write(`${scorerSummary}\n`);
  const dismissed = DismissalStore.forProject(root).ids();
  const includeDismissed = values["include-dismissed"];
  const minConfidence = minFlag ?? config.config.findings.minConfidence;
  const open = filterFindings(graph.findings, { includeDismissed }, dismissed);
  const shown = filterFindings(open, { minConfidence, includeDismissed: true });
  const hidden = {
    dismissed: includeDismissed
      ? 0
      : graph.findings.filter((f) => dismissed.has(f.id)).length,
    belowMinConfidence: open.length - shown.length,
  };
  if (values.json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          schemaVersion: graph.schemaVersion,
          minConfidence,
          findings: shown.map((f) => ({
            ...f,
            dismissed: dismissed.has(f.id),
          })),
          hidden,
          history: meta.findings.history,
          unassessableFlags: meta.findings.unassessableFlags,
          frameworks: meta.findings.frameworks,
          configWarnings: meta.config.warnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    io.stdout.write(
      formatFindings({
        findings: shown,
        dismissed,
        hidden,
        minConfidence,
        meta,
      }),
    );
  }
  if (failOn !== undefined && open.some((f) => atLeast(f.confidence, failOn))) {
    return EXIT_FINDINGS;
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
          `  summaries      ${String(s.summaries.paid + s.summaries.local)} (${String(s.summaries.paid)} paid)`,
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
export async function run(
  argv: readonly string[],
  io: CliIo,
  deps: RunDeps = {},
): Promise<number> {
  // --offline goes before or after the command. It turns the network off in
  // this process (the tripwire), and keeps only a model on this machine,
  // through the fetch from before the tripwire.
  const offline = argv.includes("--offline");
  const [command, ...rest] = argv.filter((a) => a !== "--offline");
  const wire = offline ? installTripwire() : undefined;
  const network: ScorerNetwork = wire
    ? { offline, fetch: wire.passthrough }
    : {};
  const keychain = deps.keychain ?? osKeychain();
  const env = deps.env ?? process.env;
  const runIo: RunIo = { ...io, network, env, keychain };
  try {
    if (command === "-h" || command === "--help" || command === "help") {
      io.stdout.write(USAGE);
      return EXIT_OK;
    }
    if (command === "analyze") return await analyzeCommand(rest, runIo);
    if (command === "findings") return await findingsCommand(rest, runIo);
    if (command === "cache") return cacheCommand(rest, io);
    if (command === "auth")
      return await authCommand(rest, io, {
        keychain,
        env,
        input: deps.input ?? process.stdin,
      });
    throw new UsageError(
      command === undefined ? "missing command" : `unknown command: ${command}`,
    );
  } catch (err) {
    if (err instanceof ConsentRequired) {
      // Not a failure of the analysis: the plan, for the user to agree to.
      io.stderr.write(err.message);
      return EXIT_ERROR;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr.write(`epoch: ${message}\n`);
    if (isUsageError(err)) io.stderr.write(`\n${USAGE}`);
    return EXIT_ERROR;
  } finally {
    wire?.uninstall();
  }
}
