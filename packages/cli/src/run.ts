import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  Confidence,
  HINT_DEFAULTS,
  RiskTier,
  atLeast,
  filterFindings,
  serializeCanonical,
  type Progress,
} from "@epoch-dev/core";
import {
  DEFAULT_MAX_CACHE_BYTES,
  DismissalStore,
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
  DEFAULT_JEV_MODEL,
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
import {
  EXPORT_FORMATS,
  exportGraph,
  type ExportFormat,
} from "./export-graph.js";
import { formatFindings } from "./findings.js";
import { serveAgent } from "./mcp/server.js";
import { parsePool } from "./pool.js";
import {
  formatExplain,
  formatImpact,
  formatImpactMarkdown,
  formatPath,
} from "./format-query.js";
import {
  explain,
  impact,
  impactFails,
  pathBetween,
  resolveNode,
  type Snapshot,
} from "./query.js";
import { chooseScorer } from "./scorer.js";
import { formatSummary } from "./summary.js";
import { cliVersion } from "./version.js";

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
/** `epoch impact --fail-on`: a changed file is at or above the risk tier. */
export const EXIT_IMPACT = 2;

const MIB = 1024 * 1024;

export const USAGE = `Usage:
  epoch [--offline] <command> ...
  epoch analyze <path> [--json] [--since <commit>] [--coverage <file>]
                       [hint options]
  epoch findings <path> [--json] [--min-confidence <level>] [--fail-on <level>]
                        [--include-dismissed] [hint options]
  epoch impact <path> (--base <ref> | --files <file>...) [--json | --markdown]
                      [--likely] [--fail-on <tier>]
  epoch path <path> <from> <to> [--json] [--likely]
  epoch explain <path> <file> [--json]
  epoch export <path> --format graphml|mermaid|dot [--scope <folder>]
                      [--likely] [--out <file>]
  epoch mcp [<path>]
  epoch cache stats | clear | prune [--max-size <MB>]
  epoch auth set | status | remove <provider>

Commands:
  analyze <path>   Build the dependency graph of a project folder (read-only)
  findings <path>  List likely-dead feature candidates for review: branches
                   that likely never run, possibly stale flags, possibly
                   unused files. Candidates, never verdicts
  impact <path>    What a change touches: each changed file's risk tier and
                   candidates, and every file that depends on them. --base
                   compares a commit with HEAD; --files names the files
  path <path> <from> <to>
                   How one file depends on another: the shortest chain of
                   imports, or that neither depends on the other
  explain <path> <file>
                   One file's facts: risk tier, dependents, imports,
                   importers, coverage and candidates
  export <path>    The graph as GraphML, Mermaid or Graphviz DOT, on stdout
                   or in the file given with --out
  mcp [<path>]     Answer an AI agent's questions about the project (default:
                   the current folder) over MCP on stdio: read-only, always
                   offline, graph facts only, never file contents. Your
                   agent starts it; see docs/agents.md
  cache stats      Show where the cache is and what it holds
  cache clear      Delete everything in the cache (it is derived data)
  cache prune      Evict least-recently-used entries down to --max-size
  auth set <provider>
                   Store your own key (provider: anthropic or jev) in the OS
                   keychain; it is read from standard input (typed hidden,
                   or piped), never from the command line
  auth status      Show where each key is found, never the key; an
                   environment variable (ANTHROPIC_API_KEY, JEV_API_KEY) is
                   used first
  auth remove <provider>
                   Delete a stored key from the OS keychain

Options:
  --offline          Turn the network off for this run; a model on this
                     machine (--scorer local) still works
  --json             Print the canonical graph as JSON on stdout
  --since <commit>   Also re-read files changed between <commit> and HEAD
  --coverage <file>  Use this coverage report: lcov, Cobertura, Istanbul
                     JSON, Clover or a Go profile (default: look for each
                     test tool's usual report in the project and its packages)
  --min-confidence <level>
                     high, medium or low: the lowest level listed (default:
                     findings.minConfidence in epoch.config.json, else medium)
  --fail-on <level>  Exit 2 when a non-dismissed finding is at or above level
                     (findings), or a changed file is at or above the risk
                     tier critical, high, moderate, low-moderate or low (impact)
  --include-dismissed
                     Also list findings dismissed in the app
  --base <ref>       impact: the files changed between this commit and HEAD
  --files <file>...  impact: these files, relative to <path>
  --markdown         impact: print Markdown, for a CI job summary
  --likely           impact, path, export: also follow likely relations
                     (hints at or above ${String(HINT_DEFAULTS.threshold)}), marked as such
  --format <name>    export: graphml, mermaid or dot
  --scope <folder>   export: only the files in this folder
  --out <file>       export: write this file instead of stdout
  --max-size <MB>    Cache size cap for prune (default ${String(DEFAULT_MAX_CACHE_BYTES / MIB)})
  -h, --help         Show this help
  -v, --version      Show Epoch's version

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
                     jev: TypeSafe AI's Jev with your own key, from JEV_API_KEY
                     or epoch auth (sends the same excerpts to TypeSafe; the
                     same four options as llm)
  --model <name>     The model for --scorer local, llm or jev (llm default:
                     ${DEFAULT_LLM_MODEL}; jev default: ${DEFAULT_JEV_MODEL})
  --key-env <name>   The environment variable that holds the key (llm or jev;
                     default ANTHROPIC_API_KEY or JEV_API_KEY); never argv
  --max-pairs <n>    Candidate pairs a model scores at most (default 200)
  --max-spend <USD>  Stop before a request could pass this spend (llm, jev)
  --price-in <USD>, --price-out <USD>
                     Your model's prices per million input and output tokens
  --consent-send     Send what the plan printed without it lists (llm, jev)

The cache lives in the per-user cache directory; set EPOCH_CACHE_DIR to move it.
Dismissals live in the per-user data directory; set EPOCH_DATA_DIR to move it.

Exit codes: 0 success, 1 error, 2 findings (or, for impact, a changed file's
risk tier) at or above --fail-on.
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
  const provider =
    values.scorer === "llm"
      ? "anthropic"
      : values.scorer === "jev"
        ? "jev"
        : undefined;
  // --key-env names the variable to read; the keychain fills only the default one.
  if (
    provider === undefined ||
    values["no-hints"] ||
    values["key-env"] !== undefined
  )
    return io.env;
  const key = await resolveKey(provider, io.env, io.keychain);
  if (key.value !== undefined)
    return { ...io.env, [PROVIDERS[provider].env]: key.value };
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
  const pool = parsePool();
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

/** The analysis the query commands read: default hints, no model, the shared cache. */
async function snapshotOf(target: string, io: CliIo): Promise<Snapshot> {
  const { root, graph, meta, packages } = await analyzeWithCache(
    target,
    io,
    {},
  );
  return {
    graph,
    meta,
    packages,
    dismissed: DismissalStore.forProject(root).ids(),
  };
}

/** A file argument as a repository-relative path: absolute paths are made relative to the project. */
function relativeTo(target: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(target, file) : file;
  return rel.replaceAll("\\", "/");
}

/** The node a file argument names, or a usage-free error naming the candidates. */
function nodeArg(snapshot: Snapshot, target: string, file: string): string {
  const resolved = resolveNode(snapshot, relativeTo(target, file));
  if ("id" in resolved) return resolved.id;
  throw new Error(
    resolved.candidates.length === 0
      ? resolved.error
      : `${resolved.error}\n  ${resolved.candidates.join("\n  ")}`,
  );
}

function riskTier(option: string, raw: string | undefined) {
  if (raw === undefined) return undefined;
  const parsed = RiskTier.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `${option} must be ${RiskTier.options.join(", ")}, got ${raw}`,
    );
  }
  return parsed.data;
}

async function impactCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      base: { type: "string" },
      files: { type: "string", multiple: true },
      json: { type: "boolean", default: false },
      markdown: { type: "boolean", default: false },
      likely: { type: "boolean", default: false },
      "fail-on": { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  // `--files a b c`: the names after the first are positionals.
  const [first, ...extra] = positionals;
  if (values.files === undefined && extra.length > 0) {
    throw new UsageError("impact needs exactly one <path>");
  }
  const files = [...(values.files ?? []), ...extra];
  if ((values.base === undefined) === (files.length === 0)) {
    throw new UsageError(
      "impact needs either --base <ref> or --files <file>...",
    );
  }
  if (values.json && values.markdown) {
    throw new UsageError("--json and --markdown cannot be combined");
  }
  const failOn = riskTier("--fail-on", values["fail-on"]);
  const target = targetOf("impact", first === undefined ? [] : [first]);
  const changed =
    values.base === undefined
      ? files.map((f) => relativeTo(target, f))
      : changedSince(target, values.base);
  const report = impact(await snapshotOf(target, io), changed, values.likely);
  io.stdout.write(
    values.json
      ? `${JSON.stringify(
          {
            ...(values.base === undefined ? {} : { base: values.base }),
            ...report,
          },
          null,
          2,
        )}\n`
      : values.markdown
        ? formatImpactMarkdown(report)
        : formatImpact(report),
  );
  return failOn !== undefined && impactFails(report, failOn)
    ? EXIT_IMPACT
    : EXIT_OK;
}

async function pathCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      json: { type: "boolean", default: false },
      likely: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [dir, from, to, ...rest] = positionals;
  if (
    dir === undefined ||
    from === undefined ||
    to === undefined ||
    rest.length > 0
  ) {
    throw new UsageError("path needs <path> <from> <to>");
  }
  const target = targetOf("path", [dir]);
  const snapshot = await snapshotOf(target, io);
  const report = pathBetween(
    snapshot,
    nodeArg(snapshot, target, from),
    nodeArg(snapshot, target, to),
    values.likely,
  );
  io.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatPath(report, values.likely),
  );
  return EXIT_OK;
}

async function explainCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [dir, file, ...rest] = positionals;
  if (dir === undefined || file === undefined || rest.length > 0) {
    throw new UsageError("explain needs <path> <file>");
  }
  const target = targetOf("explain", [dir]);
  const snapshot = await snapshotOf(target, io);
  const report = explain(snapshot, nodeArg(snapshot, target, file));
  io.stdout.write(
    values.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatExplain(report),
  );
  return EXIT_OK;
}

async function exportCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    options: {
      format: { type: "string" },
      scope: { type: "string" },
      likely: { type: "boolean", default: false },
      out: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  const format = EXPORT_FORMATS.find((f) => f === values.format);
  if (format === undefined) {
    throw new UsageError(
      `export needs --format ${EXPORT_FORMATS.join(", ").replace(/, ([^,]*)$/, " or $1")}`,
    );
  }
  const target = targetOf("export", positionals);
  const { graph } = await snapshotOf(target, io);
  const text = exportGraph(graph, format satisfies ExportFormat, {
    likely: values.likely,
    ...(values.scope === undefined
      ? {}
      : { scope: relativeTo(target, values.scope) }),
  });
  if (values.out === undefined) {
    io.stdout.write(text);
  } else {
    // The one file this command writes: the export the user named.
    fs.writeFileSync(path.resolve(values.out), text);
    io.stderr.write(`Wrote ${values.out}\n`);
  }
  return EXIT_OK;
}

async function mcpCommand(args: readonly string[], io: CliIo): Promise<number> {
  const { positionals } = parseArgs({
    args: [...args],
    options: {},
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new UsageError("mcp takes at most one <path>");
  }
  const target = targetOf("mcp", [positionals[0] ?? "."]);
  // stdout belongs to the protocol from here on; Epoch speaks on stderr.
  await serveAgent(target, (line) => io.stderr.write(line));
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
  const [command, ...rest] = argv.filter((a) => a !== "--offline");
  // The agent server is always offline (ADR-021).
  const offline = argv.includes("--offline") || command === "mcp";
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
    if (command === "-v" || command === "--version") {
      io.stdout.write(`${cliVersion()}\n`);
      return EXIT_OK;
    }
    if (command === "analyze") return await analyzeCommand(rest, runIo);
    if (command === "findings") return await findingsCommand(rest, runIo);
    if (command === "impact") return await impactCommand(rest, io);
    if (command === "path") return await pathCommand(rest, io);
    if (command === "explain") return await explainCommand(rest, io);
    if (command === "export") return await exportCommand(rest, io);
    if (command === "mcp") return await mcpCommand(rest, io);
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
