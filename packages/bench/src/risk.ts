/**
 * pnpm bench:risk <repo>... [--days 180] [--out docs/benchmarks/risk.md]
 *
 * The hindsight evaluation of risk tiers (ADR-015): does a file's tier at a
 * past commit say how likely it was to need a fix afterwards? On full
 * clones, for two windows:
 * - check: T = HEAD - 2 * days, labels from (T, T + days]. Disjoint from the
 *   data the thresholds were chosen on, so it is the honest test.
 * - exploration: T = HEAD - days, labels from (T, HEAD]: the window the
 *   "hot = 3+ commits" threshold was chosen on (ADR-015), for reference.
 * At T, the last mainline commit is analyzed in a shared clone (churn from
 * history up to T only). A file is "fixed later" when a later non-merge
 * commit of at most 50 files whose subject reads like a fix touched it.
 * Every number in the report comes from this script.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { HINT_DEFAULTS, RISK_TIERS, type Graph } from "@epoch-dev/core";
import { ParsePool, analyze } from "@epoch-dev/engine";
import { hostInfo, pct, repoInfo, table, writeReport } from "./report.js";
import {
  FIX_SUBJECT,
  byTier,
  precisionAtTop,
  tierRank,
  v1Scores,
  type RiskRow,
} from "./risk-eval.js";
import { forwardCommitLog, rocAuc } from "./scorer-eval.js";

const DAY = 86_400;

const git = (cwd: string, ...args: string[]): string =>
  childProcess.execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "--no-pager", ...args],
    { cwd, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024 },
  );
const iso = (t: number) => new Date(t * 1000).toISOString();
const date = (t: number) => iso(t).slice(0, 10);
const pctOrDash = (x: number) => (Number.isNaN(x) ? "–" : pct(x));
const num = (x: number) => (Number.isNaN(x) ? "–" : x.toFixed(3));

interface Window {
  readonly name: "check" | "exploration";
  readonly repo: string;
  readonly commit: string;
  readonly time: number;
  readonly until: number;
  readonly rows: readonly RiskRow[];
  readonly laterCommits: number;
}

/** The graph at `commit`, and which node each analyzed file counts for (a Go file: its package). */
async function analyzeAt(
  dir: string,
  commit: string,
  pool: ParsePool,
): Promise<{ graph: Graph; nodeOf: ReadonlyMap<string, string> }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-bench-risk-"));
  try {
    git(os.tmpdir(), "clone", "-q", "--shared", "--no-checkout", dir, tmp);
    git(tmp, "checkout", "-q", commit);
    let nodeOf: ReadonlyMap<string, string> = new Map();
    const { graph } = await analyze(tmp, {
      pool,
      hints: {
        cochange: false,
        onCandidates: (info) => {
          nodeOf = info.nodeOf;
        },
      },
    });
    return { graph, nodeOf };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function windowAt(
  dir: string,
  name: Window["name"],
  at: number,
  until: number,
  pool: ParsePool,
): Promise<Window | undefined> {
  const commit = git(
    dir,
    "rev-list",
    "-1",
    "--first-parent",
    `--before=${iso(at)}`,
    "HEAD",
  ).trim();
  if (commit === "") return undefined;
  const time = Number(git(dir, "log", "-1", "--format=%ct", commit).trim());
  const { graph, nodeOf } = await analyzeAt(dir, commit, pool);
  const log = git(
    dir,
    "log",
    "--reverse",
    "--no-merges",
    "--no-show-signature",
    "-z",
    "--name-status",
    "-M",
    "--no-ext-diff",
    "--no-textconv",
    "--format=%x01%s",
    `--since=${iso(time + 1)}`,
    `--until=${iso(until)}`,
    "HEAD",
    "--",
  );
  const commits = forwardCommitLog(log).filter(
    (c) => c.files.length <= HINT_DEFAULTS.cochange.maxFiles,
  );
  const fixes = new Map<string, number>();
  for (const c of commits) {
    if (!FIX_SUBJECT.test(c.header)) continue;
    const nodes = new Set(c.files.flatMap((f) => nodeOf.get(f) ?? []));
    for (const n of nodes) fixes.set(n, (fixes.get(n) ?? 0) + 1);
  }
  const rows: RiskRow[] = graph.nodes.flatMap((n) => {
    const risk = n.metrics.risk;
    const churn = n.metrics.churn90d;
    if (!risk || churn === undefined) return [];
    return [
      {
        id: n.id,
        tier: risk.tier,
        fanIn: n.metrics.fanIn,
        churn90d: churn,
        ...(n.metrics.coverage === undefined
          ? {}
          : { coverage: n.metrics.coverage }),
        laterFixes: fixes.get(n.id) ?? 0,
      },
    ];
  });
  return {
    name,
    repo: path.basename(dir),
    commit,
    time,
    until,
    rows,
    laterCommits: commits.length,
  };
}

function tierTable(windows: readonly Window[], repos: readonly string[]) {
  const pooled = byTier(windows.flatMap((w) => w.rows));
  const per = new Map(windows.map((w) => [w.repo, byTier(w.rows)]));
  return table(
    ["Tier", "All repositories", ...repos],
    RISK_TIERS.map((tier, i) => [
      tier,
      `${pctOrDash(pooled[i]?.rate ?? Number.NaN)} (${String(pooled[i]?.fixed ?? 0)} of ${String(pooled[i]?.files ?? 0)})`,
      ...repos.map((r) => {
        const t = per.get(r)?.[i];
        return t
          ? `${pctOrDash(t.rate)} (${String(t.fixed)} of ${String(t.files)})`
          : "–";
      }),
    ]),
  );
}

function comparisonTable(windows: readonly Window[]) {
  return table(
    [
      "Repository",
      "Files with a tier",
      "Fixed later",
      "Top two tiers: files",
      "Fixed later: top two tiers",
      "Fixed later: as many top v1 files",
      "ROC AUC: tiers",
      "ROC AUC: v1 score",
    ],
    windows.map((w) => {
      const ys = w.rows.map((r) => r.laterFixes > 0);
      const v1 = v1Scores(w.rows);
      const top = precisionAtTop(w.rows);
      return [
        w.repo,
        String(w.rows.length),
        pctOrDash(ys.filter(Boolean).length / Math.max(1, ys.length)),
        String(top.k),
        pctOrDash(top.tiers),
        pctOrDash(top.v1),
        num(
          rocAuc(
            w.rows.map((r) => tierRank(r.tier)),
            ys.map(Number),
          ),
        ),
        num(
          rocAuc(
            w.rows.map((r) => v1.get(r.id) ?? 0),
            ys.map(Number),
          ),
        ),
      ];
    }),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      days: { type: "string", default: "180" },
      out: { type: "string", default: "docs/benchmarks/risk.md" },
    },
    allowPositionals: true,
  });
  const days = Number(values.days);
  if (positionals.length === 0 || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      "usage: pnpm bench:risk <repo>... [--days 180] [--out <file>]",
    );
  }
  const pool = new ParsePool();
  const windows: Window[] = [];
  const repos: string[] = [];
  try {
    for (const dir of positionals) {
      const info = repoInfo(dir);
      const head = Number(git(dir, "log", "-1", "--format=%ct", "HEAD").trim());
      repos.push(path.basename(dir));
      for (const [name, at, until] of [
        ["check", head - 2 * days * DAY, head - days * DAY],
        ["exploration", head - days * DAY, head],
      ] as const) {
        process.stderr.write(
          `${info.name}: ${name} window at ${date(at)}...\n`,
        );
        const w = await windowAt(dir, name, at, until, pool);
        if (w) windows.push(w);
      }
    }
  } finally {
    await pool.destroy();
  }
  const check = windows.filter((w) => w.name === "check");
  const exploration = windows.filter((w) => w.name === "exploration");
  const lines = [
    "# Risk tiers: hindsight evaluation",
    "",
    "Generated by `pnpm bench:risk` (packages/bench/src/risk.ts). Do not edit by hand; every number comes from the script.",
    "",
    `Host: ${hostInfo()}.`,
    "",
    "## Protocol",
    "",
    `For each repository and window, the last mainline commit at T is analyzed in a shared clone; its risk tiers use churn from the 90 days before T only. A file counts as **fixed later** when a non-merge commit of at most ${String(HINT_DEFAULTS.cochange.maxFiles)} files in the label window touched it and its subject matches \`${FIX_SUBJECT.source}\` (renames followed). Fix commits are a proxy for defects: they miss fixes described otherwise and count some that are not.`,
    "",
    `- **Check window:** T = HEAD − ${String(2 * days)} days, labels from the next ${String(days)} days. No overlap with the data the thresholds were chosen on, so this is the test.`,
    `- **Exploration window:** T = HEAD − ${String(days)} days, labels up to HEAD. The "hot = 3 or more commits" threshold was chosen looking at this window (ADR-015); it is shown for reference, not as evidence.`,
    "",
    "The v1 score is the weighted percentile formula the tiers replaced, recomputed here only for comparison.",
    "",
    "## Data",
    "",
    table(
      [
        "Repository",
        "Window",
        "T commit",
        "Label window",
        "Later commits (≤ 50 files)",
        "Files with a tier",
      ],
      windows.map((w) => [
        w.repo,
        w.name,
        `${w.commit.slice(0, 10)} (${date(w.time)})`,
        `${date(w.time)} – ${date(w.until)}`,
        String(w.laterCommits),
        String(w.rows.length),
      ]),
    ),
    "",
    "## Check window: share of files fixed later, by tier",
    "",
    tierTable(check, repos),
    "",
    "## Check window: tiers against the v1 score",
    "",
    comparisonTable(check),
    "",
    "Top two tiers: critical and high. The v1 column takes as many files, ranked by the v1 score. ROC AUC: how well each ranks the files fixed later above the others (0.5 is chance); five tiers tie many files, which costs a ranking measure.",
    "",
    "## Exploration window (thresholds chosen here; reference only)",
    "",
    tierTable(exploration, repos),
    "",
    comparisonTable(exploration),
    "",
  ];
  writeReport(path.resolve(values.out), lines.join("\n"));
  process.stderr.write(`wrote ${values.out}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
