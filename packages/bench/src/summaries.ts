/**
 * pnpm bench:summaries <repo> [--from <rev>] [--to <rev>] [--model <id>]
 *                     [--out docs/benchmarks/summaries.md]
 *                     [--price-in <usd> --price-out <usd> --price-source <url>]
 *                     [--send --max-spend <usd> [--key-env <NAME>]]
 *
 * What summaries cost, a full run versus an incremental one (M7; CLAUDE.md
 * "Token accounting"). In a shared clone, the project at --from (default
 * HEAD~1) is summarized the way the app's root folder job does it, on an
 * empty summary cache; then the clone moves to --to (default HEAD) and the
 * same job runs again on that cache, sending only what is no longer fresh.
 *
 * Without --send nothing leaves the machine: every request is Epoch's own
 * upper estimate (see summary-run.ts). With --send, every request goes to
 * Anthropic with the key in the environment variable --key-env names
 * (ANTHROPIC_API_KEY by default; never read from the command line), each
 * holding its worst case against --max-spend before it is
 * sent; the run stops when the next request could pass the cap. Prices are
 * the user's, with the page they came from. Files that look like secrets
 * are never sent. Every number in the report comes from this script.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_CLAUDE_MODEL } from "@epoch-dev/core";
import {
  FsReader,
  MemoryCacheStore,
  SummaryStore,
  analyze,
  toPosix,
  type SummarySource,
} from "@epoch-dev/engine";
import {
  ANTHROPIC_ORIGIN,
  SpendCap,
  anthropicTextModel,
  createNet,
  estimateTokens,
  type Prices,
} from "@epoch-dev/scorers";
import { SUMMARY_MAX_OUTPUT_TOKENS } from "@epoch-dev/scorers/summary";
import { hostInfo, repoInfo, table, writeReport } from "./report.js";
import {
  estimateOnly,
  runSummaryJob,
  type Generate,
  type JobReport,
} from "./summary-run.js";

const git = (cwd: string, ...args: string[]): string =>
  childProcess.execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "--no-pager", ...args],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string", default: "HEAD~1" },
    to: { type: "string", default: "HEAD" },
    model: { type: "string", default: DEFAULT_CLAUDE_MODEL },
    out: { type: "string", default: "docs/benchmarks/summaries.md" },
    "price-in": { type: "string" },
    "price-out": { type: "string" },
    "price-source": { type: "string" },
    send: { type: "boolean", default: false },
    "max-spend": { type: "string" },
    // Another name keeps tools that also read ANTHROPIC_API_KEY (Claude
    // Code among them) from picking the key up.
    "key-env": { type: "string", default: "ANTHROPIC_API_KEY" },
  },
});

function fail(message: string): never {
  process.stderr.write(`bench:summaries: ${message}\n`);
  process.exit(1);
}

const [repoArg] = positionals;
if (repoArg === undefined || positionals.length > 1)
  fail("give one repository checkout");
const usd = (name: string, raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a dollar amount`);
  return n;
};
const priceIn = usd("price-in", values["price-in"]);
const priceOut = usd("price-out", values["price-out"]);
const maxSpend = usd("max-spend", values["max-spend"]);
if ((priceIn === undefined) !== (priceOut === undefined))
  fail("give both --price-in and --price-out");
const prices: Prices | undefined =
  priceIn !== undefined && priceOut !== undefined
    ? { inputPerMTok: priceIn, outputPerMTok: priceOut }
    : undefined;
if (prices && values["price-source"] === undefined)
  fail("--price-source must name the page the prices came from");
const keyEnv = values["key-env"];
if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv))
  fail("--key-env must be an environment variable name");
const apiKey = process.env[keyEnv];
if (values.send) {
  if (!prices) fail("--send needs --price-in, --price-out and --price-source");
  if (maxSpend === undefined) fail("--send needs --max-spend");
  if (apiKey === undefined || apiKey === "")
    fail(`--send needs the key in ${keyEnv}`);
}

const repo = repoInfo(repoArg);
const fromCommit = git(repo.root, "rev-parse", values.from).trim();
const toCommit = git(repo.root, "rev-parse", values.to).trim();
const short = (c: string) => c.slice(0, 10);

const MODEL = { provider: "anthropic", model: values.model } as const;
const worstCase = (prompt: { system: string; user: string }) => ({
  inputTokens: estimateTokens(prompt.system + prompt.user),
  outputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
});

/** Anthropic, each request held against the cap first. */
function sending(cap: SpendCap): Generate {
  const model = anthropicTextModel({
    apiKey: apiKey ?? "",
    model: values.model,
    net: createNet({ offline: false, allow: [ANTHROPIC_ORIGIN] }),
  });
  return async (plan) => {
    const hold = cap.reserve(worstCase(plan.prompt));
    try {
      const r = await model.generate({
        system: plan.prompt.system,
        user: plan.prompt.user,
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      });
      hold.settle(r.usage);
      return { ...r, costUsd: cap.costOfUsage(r.usage) };
    } catch (err) {
      hold.release();
      throw err;
    }
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-bench-summaries-"));

async function sourceAt(commit: string): Promise<SummarySource> {
  git(tmp, "checkout", "-q", "--force", commit);
  const result = await analyze(tmp, { hints: false, history: false });
  const reader = new FsReader(result.root);
  return {
    root: result.root,
    graph: result.graph,
    packages: result.packages,
    readText: (rel) => reader.readFile(`${result.root}/${rel}`),
  };
}

interface Phase {
  readonly name: string;
  readonly estimate: JobReport;
  readonly measured?: JobReport;
}

const cap =
  values.send && prices && maxSpend !== undefined
    ? new SpendCap(maxSpend, prices)
    : undefined;

/** Both runs in a shared clone, estimated and (with --send) measured. */
async function measure(): Promise<{
  phases: Phase[];
  nodes: { from: number; to: number };
  changedSources: number;
}> {
  git(os.tmpdir(), "clone", "-q", "--shared", "--no-checkout", repo.root, tmp);
  const estimates = new SummaryStore(new MemoryCacheStore(), toPosix(tmp));
  const measured = new SummaryStore(new MemoryCacheStore(), toPosix(tmp));
  const phases: Phase[] = [];

  const from = await sourceAt(fromCommit);
  const full = await runSummaryJob(from, estimates, MODEL, estimateOnly());
  if (cap) {
    const files = full.sent.filter((r) => r.kind !== "dir").length;
    process.stderr.write(
      `Sending ${String(files)} files of ${repo.name} at ${short(fromCommit)}, then what changed by ${short(toCommit)}, to ${ANTHROPIC_ORIGIN} (${values.model}) with the key in ${keyEnv}. Cap $${cap.capUsd.toFixed(2)}.\n`,
    );
  }
  phases.push({
    name: "Full run",
    estimate: full,
    ...(cap
      ? { measured: await runSummaryJob(from, measured, MODEL, sending(cap)) }
      : {}),
  });

  const to = await sourceAt(toCommit);
  const inGraph = new Set([
    ...to.graph.nodes.map((n) => n.id),
    ...[...to.packages.values()].flat(),
  ]);
  const changedSources = git(tmp, "diff", "--name-only", fromCommit, toCommit)
    .split("\n")
    .filter((f) => inGraph.has(f)).length;
  phases.push({
    name: "Incremental run",
    estimate: await runSummaryJob(to, estimates, MODEL, estimateOnly()),
    ...(cap
      ? { measured: await runSummaryJob(to, measured, MODEL, sending(cap)) }
      : {}),
  });
  return {
    phases,
    nodes: { from: from.graph.nodes.length, to: to.graph.nodes.length },
    changedSources,
  };
}

let run: Awaited<ReturnType<typeof measure>>;
try {
  run = await measure();
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const { phases, nodes, changedSources } = run;

// The report.
const sum = (
  rows: JobReport["sent"],
  f: (r: JobReport["sent"][number]) => number,
) => rows.reduce((t, r) => t + f(r), 0);
const count = (
  rows: JobReport["sent"],
  f: (r: JobReport["sent"][number]) => boolean,
) => String(rows.filter(f).length);
const dollars = (x: number) =>
  `$${x > 0 && x < 0.01 ? x.toFixed(4) : x < 1 ? x.toFixed(3) : x.toFixed(2)}`;
const isNode = (r: JobReport["sent"][number]) => r.kind !== "dir";

type Row = JobReport["sent"][number];

/** What the app sends by itself: new and changed files, as each is opened. */
const automatic = (r: Row) =>
  isNode(r) && (r.status === "missing" || r.status === "stale-file");

/** The table's runs: both jobs, and the automatic part of the incremental one. */
function runs(pick: (p: Phase) => JobReport | undefined): {
  name: string;
  job: JobReport | undefined;
  rows: readonly Row[];
}[] {
  const [full, incremental] = phases;
  const fullJob = full && pick(full);
  const incJob = incremental && pick(incremental);
  return [
    { name: "Full run", job: fullJob, rows: fullJob?.sent ?? [] },
    {
      name: "Incremental run, whole project",
      job: incJob,
      rows: incJob?.sent ?? [],
    },
    {
      name: "Incremental run, new and changed files only",
      job: undefined,
      rows: (incJob?.sent ?? []).filter(automatic),
    },
  ];
}

function notSent(job: JobReport | undefined): string {
  if (!job) return "–";
  const by = new Map<string, number>();
  for (const s of job.skipped) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  return by.size === 0
    ? "0"
    : [...by].map(([reason, n]) => `${String(n)} ${reason}`).join(", ");
}

const estimateRows = runs((p) => p.estimate).map(({ name, job, rows }) => {
  const input = sum(rows, (r) => r.inputTokens);
  const output = sum(rows, (r) => r.outputTokens);
  return [
    name,
    job ? String(job.subjects) : "–",
    job ? String(job.fresh) : "–",
    notSent(job),
    String(rows.length),
    count(rows, (r) => isNode(r) && r.status === "missing"),
    count(rows, (r) => isNode(r) && r.status === "stale-file"),
    count(rows, (r) => isNode(r) && r.status === "stale-dependencies"),
    count(rows, (r) => !isNode(r)),
    String(input),
    String(output),
    prices
      ? dollars(
          (input * prices.inputPerMTok + output * prices.outputPerMTok) / 1e6,
        )
      : "–",
  ];
});

const measuredSection = phases.every((p) => p.measured)
  ? [
      `Sent to ${ANTHROPIC_ORIGIN}, model \`${values.model}\`, one request at a time. Tokens and dollars are what the API reported, priced at ${dollars(prices?.inputPerMTok ?? 0)} per million input tokens and ${dollars(prices?.outputPerMTok ?? 0)} per million output tokens (${values["price-source"] ?? ""}). Cap: ${dollars(maxSpend ?? 0)}.`,
      "",
      table(
        [
          "Run",
          "Requests",
          "Stored",
          "Not stored (refusal, cut off, emptied)",
          "Input tokens",
          "Output tokens",
          "Cost",
          "Time in requests",
          "Stopped early",
        ],
        runs((p) => p.measured).map(({ name, job, rows }) => [
          name,
          String(rows.length),
          count(rows, (r) => r.stored),
          count(rows, (r) => !r.stored),
          String(sum(rows, (r) => r.inputTokens)),
          String(sum(rows, (r) => r.outputTokens)),
          dollars(sum(rows, (r) => r.costUsd)),
          `${(sum(rows, (r) => r.ms) / 1000).toFixed(1)} s`,
          job ? (job.stoppedBy ?? "no") : "–",
        ]),
      ),
    ]
  : [
      "**Not measured.** No run with `--send` has been made: it needs an Anthropic key in an environment variable (`ANTHROPIC_API_KEY`, or the one `--key-env` names), prices from Anthropic's pricing page, and a spending cap. Only Epoch's own estimate is shown above; no number on this page is a measured token count or cost.",
    ];

const skipped = phases.flatMap((p) => p.estimate.skipped);
const secrets = new Set(
  skipped.filter((s) => s.reason === "secret").map((s) => s.subject),
);

writeReport(
  values.out,
  [
    "# Summary cost: full run vs incremental run",
    "",
    "Generated by `pnpm bench:summaries`. Every number on this page comes from that script.",
    "",
    `Repository: ${repo.name}${repo.url ? ` (${repo.url})` : ""}. Full run at ${short(fromCommit)} (${String(nodes.from)} files and packages); incremental run at ${short(toCommit)} (${String(nodes.to)}), where ${String(changedSources)} analyzed source files differ from ${short(fromCommit)}.`,
    "",
    `Host: ${hostInfo()}.`,
    "",
    "## Method",
    "",
    "Each run is the app's summary job for the whole project: every file and package bottom-up over the certain edges (a cycle as one group), each prompt carrying the summaries of up to eight of its direct imports, then every folder from the deepest up, made from its children's summaries. The full run starts on an empty summary cache. The incremental run uses the cache the full run left: a summary is fresh, and sends nothing, when its file's content and the summaries it used are unchanged.",
    "",
    "In the incremental run a new or changed file is sent again; the app does that by itself when the file is opened (the last row). A file whose imports' summaries changed is sent again only in a job like this one, which the user confirms; the app never does that by itself. A folder is made again when a child's summary changed. Empty files are not sent, and a folder is made from the children that have something to summarize.",
    "",
    `Files that look like secrets (by name or content) are never sent${secrets.size > 0 ? `; ${String(secrets.size)} were left out here` : ""}.`,
    "",
    "## Epoch's estimate (nothing sent)",
    "",
    "The worst case Epoch holds against the spending cap before each request, without a model: input tokens are the prompt's UTF-8 bytes divided by 2.5 (a deliberately high guess for code), output tokens the per-request cap of " +
      `${String(SUMMARY_MAX_OUTPUT_TOKENS)}, and each stored summary a stand-in of the maximum length, different whenever its input changed, so every change reaches what depends on it. A real model writes shorter summaries and fewer tokens; this is an upper bound, not a measurement.`,
    "",
    table(
      [
        "Run",
        "Subjects",
        "Fresh (cached)",
        "Not sent",
        "Requests",
        "New files",
        "Changed files",
        "Imports' summaries changed",
        "Folders",
        "Input tokens (est.)",
        "Output tokens (cap)",
        "Worst case",
      ],
      estimateRows,
    ),
    "",
    prices
      ? `Worst case priced at ${dollars(prices.inputPerMTok)} per million input tokens and ${dollars(prices.outputPerMTok)} per million output tokens (${values["price-source"] ?? ""}).`
      : "No prices were given, so no dollar amounts. Epoch ships no prices.",
    "",
    "## Measured",
    "",
    ...measuredSection,
    "",
    "## Limits",
    "",
    "- One repository and one pair of commits; what an incremental run costs depends on how many files changed and how many depend on them.",
    "- Summaries made one at a time, as in the app; time in requests excludes analysis.",
    "- The estimate assumes every regenerated summary differs from the last one; a model that repeated itself would stop the cascade earlier.",
  ].join("\n"),
);
process.stderr.write(`Wrote ${values.out}\n`);
