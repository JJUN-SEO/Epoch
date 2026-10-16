/**
 * pnpm bench:scorers <repo>... [--days 180] [--out docs/benchmarks/scorers.md]
 *                    [--embedding-model models/<id>]
 *                    [--write-coefficients packages/scorers/src/coefficients.json]
 *
 * The M6 evaluation of hint scorers (ADR-008, PLAN.md M6), on pinned full
 * clones, as a temporal holdout:
 * - T = HEAD - days, T0 = T - days. At each, the last mainline commit is
 *   checked out in a shared clone and analyzed; every candidate the Enrich
 *   stage proposes is kept with its signals (co-change from history up to
 *   that commit only, shared strings from its files, and with
 *   --embedding-model, similarity from the local model).
 * - A candidate source -> target claims "when target changes, source
 *   changes too". It is labeled with the next `days` of commits: judged only
 *   if target changed, positive if a commit changed both. Pairs a fact edge
 *   already covers are left out (they are never shown as hints).
 * - The heuristic has two coefficient sets. "Without a model" is fitted on
 *   the candidates the app proposes with no embedding model (co-change and
 *   shared strings, no cosine); "with a model" on every candidate of a run
 *   with one. Both are fitted on the T0 labels only (each repository
 *   weighing the same), and every scorer is evaluated on T: nothing after T
 *   is used to propose, fit or choose.
 * Every number in the report comes from this script.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  HINT_DEFAULTS,
  hintEdges,
  type CandidatePair,
  type HintSignals,
  type ScoredRelation,
} from "@epoch-dev/core";
import { ParsePool } from "@epoch-dev/engine";
import {
  loadOnnxEmbedder,
  type OnnxEmbedder,
} from "@epoch-dev/engine/onnx-embedder";
import {
  ConsentRequired,
  DEFAULT_COEFFICIENTS,
  HeuristicScorer,
  JEV_STATUS,
  SCORER_ARGS,
  heuristicFeatures,
  resolveModel,
  runSummary,
  type HeuristicCoefficients,
  type HeuristicModel,
  type ModelRunReport,
  type ResolvedModel,
} from "@epoch-dev/scorers";
import { hostInfo, pct, repoInfo, table, writeReport } from "./report.js";
import {
  brier,
  expectedCalibrationError,
  fitLogistic,
  labelCandidates,
  precisionRecall,
  reliability,
  rocAuc,
  type Labeled,
} from "./scorer-eval.js";
import {
  headTime,
  laterCommits,
  snapshotAt,
  type Snapshot,
} from "./scorers-data.js";

const DAY = 86_400;
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const BINS = 10;

/** What the app proposes with no embedding model: co-change and shared strings, without a cosine. */
function withoutModel(c: CandidatePair): CandidatePair | undefined {
  const { cochange, strings } = c.signals;
  if (!cochange && !strings) return undefined;
  const signals: HintSignals = {
    ...(cochange ? { cochange } : {}),
    ...(strings ? { strings } : {}),
  };
  return { ...c, signals };
}

interface Split {
  readonly snapshot: Snapshot;
  /** Directed pairs that changed together later, and how many of them were candidates. */
  readonly positivePairs: number;
  readonly candidatePositives: number;
  /** The same, counting only the candidates proposed without a model. */
  readonly candidatePositivesWithoutModel: number;
  readonly excluded: number;
  /** Candidates no fact edge covers, judged. */
  readonly labeled: readonly Labeled[];
  /** The same candidates as the app proposes them without a model. */
  readonly labeledWithoutModel: readonly Labeled[];
  readonly factCovered: number;
}

interface RepoRun {
  readonly name: string;
  readonly commit: string | null;
  readonly head: number;
  readonly train: Split;
  readonly test: Split;
}

const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const num = (x: number, digits = 3) =>
  Number.isNaN(x) ? "–" : x.toFixed(digits);
const pctOrDash = (x: number) => (Number.isNaN(x) ? "–" : pct(x));

async function split(
  dir: string,
  at: number,
  days: number,
  pool: ParsePool,
  embedder: OnnxEmbedder | undefined,
  model?: ResolvedModel,
): Promise<Split | undefined> {
  const snapshot = await snapshotAt(dir, at, {
    pool,
    ...(embedder ? { embedder } : {}),
    ...(model
      ? {
          model,
          onPlan: (text: string) => {
            process.stderr.write(text);
          },
        }
      : {}),
  });
  if (!snapshot) return undefined;
  if (embedder && snapshot.embeddings.status !== "ready") {
    throw new Error(
      `${embedder.modelId}: the embedding model failed at ${snapshot.commit}`,
    );
  }
  const later = laterCommits(
    dir,
    snapshot.time,
    snapshot.time + days * DAY,
    snapshot.nodeOf,
  );
  const all = labelCandidates(snapshot.candidates, later);
  const base = labelCandidates(
    snapshot.candidates.flatMap((c) => withoutModel(c) ?? []),
    later,
  );
  const covered = (c: CandidatePair) =>
    snapshot.facts.has(`${c.source}\u0000${c.target}`);
  return {
    snapshot,
    positivePairs: all.positivePairs,
    candidatePositives: all.candidatePositives,
    candidatePositivesWithoutModel: base.candidatePositives,
    excluded: all.excluded,
    labeled: all.labeled.filter((l) => !covered(l.candidate)),
    labeledWithoutModel: base.labeled.filter((l) => !covered(l.candidate)),
    factCovered: snapshot.candidates.filter(covered).length,
  };
}

/** Features in coefficient order, with the intercept's 1 first. */
const row = (c: CandidatePair) => [1, ...heuristicFeatures(c.signals)];

/** One coefficient set, fitted on each repository's labels, the repositories weighing the same. */
function fit(perRepo: readonly (readonly Labeled[])[]): HeuristicCoefficients {
  const xs: number[][] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  const used = perRepo.filter((labeled) => labeled.length > 0);
  const total = used.reduce((n, labeled) => n + labeled.length, 0);
  for (const labeled of used) {
    // The mean weight is 1.
    const w = total / (used.length * labeled.length);
    for (const l of labeled) {
      xs.push(row(l.candidate));
      ys.push(l.y);
      ws.push(w);
    }
  }
  const [intercept = 0, ratio = 0, support = 0, strings = 0, cosine = 0] =
    fitLogistic(xs, ys, ws, { l2: 1 });
  return {
    intercept,
    cochangeRatio: ratio,
    cochangeSupport: support,
    stringWeight: strings,
    embeddingCosine: cosine,
  };
}

interface Scorer {
  readonly name: string;
  readonly p: (c: CandidatePair) => number;
}

function metrics(labeled: readonly Labeled[], p: (c: CandidatePair) => number) {
  const ps = labeled.map((l) => p(l.candidate));
  const ys = labeled.map((l) => l.y);
  return {
    n: labeled.length,
    prevalence: ys.filter((y) => y === 1).length / Math.max(1, ys.length),
    meanP: ps.reduce((a, b) => a + b, 0) / Math.max(1, ps.length),
    brier: brier(ps, ys),
    ece: expectedCalibrationError(ps, ys, BINS),
    auc: rocAuc(ps, ys),
    pr: precisionRecall(ps, ys, THRESHOLDS),
    bins: reliability(ps, ys, BINS),
  };
}

function scorerTable(
  labeled: readonly Labeled[],
  scorers: readonly Scorer[],
): string {
  return table(
    ["Scorer", "Judged", "Positive rate", "Mean p", "Brier", "ECE", "ROC AUC"],
    scorers.map((s) => {
      const m = metrics(labeled, s.p);
      return [
        s.name,
        String(m.n),
        pct(m.prevalence),
        num(m.meanP),
        num(m.brier),
        num(m.ece),
        num(m.auc),
      ];
    }),
  );
}

const signalOf = (c: CandidatePair): string =>
  c.signals.cochange && c.signals.strings
    ? "co-change and shared strings"
    : c.signals.cochange
      ? "co-change only"
      : c.signals.strings
        ? "shared strings only"
        : c.signals.embedding
          ? "similarity only"
          : "other";

/** The model scorers' rows: measured on the pairs a model scored, next to the fitted heuristic on the same pairs. */
function modelSection(
  runs: readonly RepoRun[],
  model: ResolvedModel | undefined,
  heuristic: HeuristicScorer,
): string[] {
  const status = (kind: "local" | "llm") =>
    model?.backend.id.startsWith(`${kind}:`) === true
      ? "run (below)"
      : "not run";
  const lines = [
    table(
      ["Scorer", "Status"],
      [
        ["Local model (Ollama)", status("local")],
        ["LLM (Claude, your key)", status("llm")],
        ["Jev", JEV_STATUS],
      ],
    ),
  ];
  if (!model) return lines;
  const judged: { p: number; h: number; y: number }[] = [];
  const reports: ModelRunReport[] = [];
  for (const r of runs) {
    const m = r.test.snapshot.model;
    if (!m) continue;
    reports.push(m.report);
    const scores = new Map(
      m.scores.map((x) => [`${x.source}\u0000${x.target}`, x.probability]),
    );
    for (const l of r.test.labeled) {
      const p = scores.get(`${l.candidate.source}\u0000${l.candidate.target}`);
      if (p === undefined) continue;
      judged.push({ p, h: heuristic.probability(l.candidate.signals), y: l.y });
    }
  }
  const ys = judged.map((j) => j.y);
  const row = (name: string, ps: number[]) => [
    name,
    String(ps.length),
    pct(ys.filter((y) => y === 1).length / Math.max(1, ys.length)),
    num(brier(ps, ys)),
    num(expectedCalibrationError(ps, ys, BINS)),
    num(rocAuc(ps, ys)),
  ];
  const sum = (f: (r: ModelRunReport) => number) =>
    reports.reduce((n, r) => n + f(r), 0);
  lines.push(
    "",
    `### ${model.backend.id} on the pairs it scored`,
    "",
    table(
      ["Scorer", "Judged", "Positive rate", "Brier", "ECE", "ROC AUC"],
      [
        row(
          model.backend.id,
          judged.map((j) => j.p),
        ),
        row(
          "Heuristic, fitted, same pairs",
          judged.map((j) => j.h),
        ),
      ],
    ),
    "",
    `It scored at most ${String(model.maxPairs)} pairs per repository, the heuristic's likeliest first, so these pairs are not a random sample. ${runSummary(
      model.backend,
      {
        sent: sum((r) => r.sent),
        scored: sum((r) => r.scored),
        failed: sum((r) => r.failed),
        skippedSecret: sum((r) => r.skippedSecret),
        overLimit: sum((r) => r.overLimit),
        stoppedAtCap: reports.some((r) => r.stoppedAtCap),
        unsentAtCap: sum((r) => r.unsentAtCap),
        unverifiedSymbols: sum((r) => r.unverifiedSymbols),
        usage: {
          inputTokens: sum((r) => r.usage.inputTokens),
          outputTokens: sum((r) => r.usage.outputTokens),
        },
        spentUsd: model.spend?.spentUsd ?? 0,
      },
      model.spend,
    )}.`,
  );
  return lines;
}

/** The embedding model's description, as scripts/fetch-model.mjs wrote it. */
function modelCard(dir: string): {
  readonly license: string;
  readonly source: string;
  readonly bytes: number;
} {
  const card = JSON.parse(
    fs.readFileSync(path.join(dir, "epoch-model.json"), "utf8"),
  ) as { license?: unknown; source?: unknown };
  return {
    license: typeof card.license === "string" ? card.license : "unknown",
    source: typeof card.source === "string" ? card.source : "unknown",
    bytes: fs.statSync(path.join(dir, "model.onnx")).size,
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      days: { type: "string", default: "180" },
      out: { type: "string", default: "docs/benchmarks/scorers.md" },
      "embedding-model": { type: "string" },
      "write-coefficients": { type: "string" },
      ...SCORER_ARGS,
    },
    allowPositionals: true,
  });
  const days = Number(values.days);
  if (positionals.length === 0 || !Number.isFinite(days) || days <= 0) {
    throw new Error(
      "usage: pnpm bench:scorers <repo>... [--days 180] [--out <file>] [--embedding-model <dir>] [--write-coefficients <file>]",
    );
  }
  // A model scorer (opt-in) scores each repository's T candidates; one
  // spend cap covers the whole run.
  const model = resolveModel(values);
  const modelDir = values["embedding-model"];
  const embedder = modelDir
    ? await loadOnnxEmbedder(path.resolve(modelDir))
    : undefined;
  const pool = new ParsePool();
  const runs: RepoRun[] = [];
  try {
    for (const dir of positionals) {
      const info = repoInfo(dir);
      const head = headTime(dir);
      const t = head - days * DAY;
      process.stderr.write(
        `${info.name}: snapshot T0 ${date(t - days * DAY)}...\n`,
      );
      const train = await split(dir, t - days * DAY, days, pool, embedder);
      process.stderr.write(`${info.name}: snapshot T ${date(t)}...\n`);
      const test = await split(dir, t, days, pool, embedder, model);
      if (!train || !test) {
        process.stderr.write(`${info.name}: history too short, skipped\n`);
        continue;
      }
      runs.push({ name: info.name, commit: info.commit, head, train, test });
    }
  } finally {
    await pool.destroy();
    await embedder?.close();
  }
  if (runs.length === 0) throw new Error("no repository had enough history");

  // Without a model the cosine column is all zeros, and the L2 penalty
  // keeps its coefficient at 0.
  const fitted: HeuristicModel = {
    withoutEmbeddings: fit(runs.map((r) => r.train.labeledWithoutModel)),
    withEmbeddings: embedder
      ? fit(runs.map((r) => r.train.labeled))
      : DEFAULT_COEFFICIENTS.withEmbeddings,
  };
  const fittedScorer = new HeuristicScorer(fitted);
  const shipped = new HeuristicScorer(DEFAULT_COEFFICIENTS);
  const rate = (labeled: readonly Labeled[]) =>
    labeled.filter((l) => l.y === 1).length / Math.max(1, labeled.length);
  const trainRateWithout = rate(
    runs.flatMap((r) => r.train.labeledWithoutModel),
  );
  const trainRateAll = rate(runs.flatMap((r) => r.train.labeled));
  const cochangeAlone: Scorer = {
    name: "Co-change ratio alone",
    p: (c) => {
      const x = c.signals.cochange;
      return x && x.targetCommits > 0 ? x.together / x.targetCommits : 0;
    },
  };
  const withoutScorers: Scorer[] = [
    {
      name: "Heuristic, fitted on T0",
      p: (c) => fittedScorer.probability(c.signals),
    },
    {
      name: "Heuristic, shipped coefficients",
      p: (c) => shipped.probability(c.signals),
    },
    cochangeAlone,
    { name: "Constant (T0 positive rate)", p: () => trainRateWithout },
  ];
  const withScorers: Scorer[] = [
    {
      name: "Heuristic with a model, fitted on T0",
      p: (c) => fittedScorer.probability(c.signals),
    },
    {
      name: "Heuristic with a model, shipped coefficients",
      p: (c) => shipped.probability(c.signals),
    },
    {
      name: "Heuristic without a model, fitted on T0 (similarity-only pairs at 0: never proposed)",
      p: (c) => {
        const base = withoutModel(c);
        return base ? fittedScorer.probability(base.signals) : 0;
      },
    },
    {
      name: "Cosine alone",
      p: (c) => c.signals.embedding?.cosine ?? 0,
    },
    cochangeAlone,
    { name: "Constant (T0 positive rate)", p: () => trainRateAll },
  ];
  // The scorer the app runs: with a model when this run had one.
  const primary = embedder ? withScorers[0] : withoutScorers[0];
  const pooled = runs.flatMap((r) =>
    embedder ? r.test.labeled : r.test.labeledWithoutModel,
  );
  const pooledWithout = runs.flatMap((r) => r.test.labeledWithoutModel);
  const card = modelDir ? modelCard(path.resolve(modelDir)) : undefined;

  const lines: string[] = [];
  lines.push(
    "# Hint scorers: temporal holdout",
    "",
    "Generated by `pnpm bench:scorers` (packages/bench/src/scorers.ts). Do not edit by hand; every number comes from the script.",
    "",
    `Host: ${hostInfo()}.`,
    "",
    "## Protocol",
    "",
    `For each repository, T is ${String(days)} days before HEAD's commit date and T0 is ${String(days)} days before T. At each, the last mainline commit is analyzed in a shared clone, and every candidate the Enrich stage proposes (git co-change in the 365 days before that commit, shared rare strings in its files${embedder ? ", and each file's nearest neighbors by the local embedding model" : ""}) is kept with its signals. A candidate \`source -> target\` claims "when target changes, source changes too"; the next ${String(days)} days of non-merge commits (at most ${String(HINT_DEFAULTS.cochange.maxFiles)} files each, renames followed) judge it when target changed: positive if a commit changed both. Candidates whose target did not change are left out, and so are pairs a fact edge already covers (they are never shown as hints).`,
    "",
    "The heuristic has two coefficient sets: one for the candidates the app proposes without an embedding model (co-change and shared strings, no cosine), one for every candidate when the model ran (each then has a cosine). Each is fitted on the T0 labels (a weighted logistic regression, each repository weighing the same, L2 1 on the slopes). All scorers are evaluated on T. Nothing after T is used to propose, fit or choose.",
    "",
  );
  if (embedder && card) {
    const texts = runs.reduce(
      (n, r) =>
        n + r.train.snapshot.embedded.texts + r.test.snapshot.embedded.texts,
      0,
    );
    const ms = runs.reduce(
      (n, r) => n + r.train.snapshot.embedded.ms + r.test.snapshot.embedded.ms,
      0,
    );
    lines.push(
      "## Embedding model",
      "",
      table(
        [
          "Model",
          "License",
          "ONNX file",
          "Dimensions",
          "Token limit",
          "Pooling",
          "Files embedded",
          "CPU time per file",
        ],
        [
          [
            `${embedder.modelId} (${card.source})`,
            card.license,
            `${num(card.bytes / 1e6, 1)} MB`,
            String(embedder.spec.dimensions),
            String(embedder.spec.maxTokens),
            embedder.spec.pooling,
            String(texts),
            `${num(ms / Math.max(1, texts), 1)} ms`,
          ],
        ],
      ),
      "",
      `Each file's text is its path and its first ${String(HINT_DEFAULTS.embeddings.maxChars)} characters, run one at a time on the CPU (onnxruntime-node). Neighbors: the ${String(HINT_DEFAULTS.embeddings.k)} nearest per file at cosine ${String(HINT_DEFAULTS.embeddings.minCosine)} or more.`,
      "",
    );
  }
  lines.push(
    "## Data",
    "",
    table(
      [
        "Repository",
        "HEAD",
        "T0 commit",
        "T commit",
        "Candidates at T0",
        "Judged at T0 (positive)",
        "Candidates at T",
        ...(embedder ? ["Similarity only at T"] : []),
        "Fact-covered at T",
        "Target unchanged at T",
        "Judged at T (positive)",
        "Candidate recall at T",
        ...(embedder ? ["Candidate recall without the model"] : []),
      ],
      runs.map((r) => {
        const pos = (labeled: readonly Labeled[]) =>
          `${String(labeled.length)} (${pct(rate(labeled))})`;
        const view = (s: Split) =>
          embedder ? s.labeled : s.labeledWithoutModel;
        const recall = (n: number) =>
          `${pctOrDash(n / r.test.positivePairs)} (${String(n)} of ${String(r.test.positivePairs)})`;
        const candidates = (s: Split) =>
          embedder
            ? s.snapshot.candidates.length
            : s.snapshot.candidates.filter((c) => withoutModel(c)).length;
        return [
          r.name,
          `${(r.commit ?? "").slice(0, 10)} (${date(r.head)})`,
          `${r.train.snapshot.commit.slice(0, 10)} (${date(r.train.snapshot.time)})`,
          `${r.test.snapshot.commit.slice(0, 10)} (${date(r.test.snapshot.time)})`,
          String(candidates(r.train)),
          pos(view(r.train)),
          String(candidates(r.test)),
          ...(embedder
            ? [
                String(
                  r.test.snapshot.candidates.filter((c) => !withoutModel(c))
                    .length,
                ),
              ]
            : []),
          String(r.test.factCovered),
          String(r.test.excluded),
          pos(view(r.test)),
          recall(
            embedder
              ? r.test.candidatePositives
              : r.test.candidatePositivesWithoutModel,
          ),
          ...(embedder ? [recall(r.test.candidatePositivesWithoutModel)] : []),
        ];
      }),
    ),
    "",
    embedder
      ? "Candidate recall: of the directed pairs of files that changed together after T, the share the generators had proposed at T (fact-covered pairs included), with and without the model's similarity candidates."
      : "Candidate recall: of the directed pairs of files that changed together after T, the share the generators had proposed at T (fact-covered pairs included). The rest are pairs with no history together and no shared rare string; only a semantic signal could find them.",
    "",
    "## Fitted coefficients",
    "",
    table(
      [
        "Coefficient",
        "Without a model: fitted on T0",
        "Without a model: shipped",
        "With a model: fitted on T0",
        "With a model: shipped",
      ],
      (
        [
          ["intercept", "intercept"],
          ["co-change ratio", "cochangeRatio"],
          ["co-change support, ln(1 + together)", "cochangeSupport"],
          ["shared-string weight", "stringWeight"],
          ["embedding cosine", "embeddingCosine"],
        ] as const
      ).map(([label, key]) => [
        label,
        num(fitted.withoutEmbeddings[key]),
        num(DEFAULT_COEFFICIENTS.withoutEmbeddings[key]),
        embedder ? num(fitted.withEmbeddings[key]) : "not fitted",
        num(DEFAULT_COEFFICIENTS.withEmbeddings[key]),
      ]),
    ),
    "",
    `Shipped: packages/scorers/src/coefficients.json when this report was generated. ADR-008 records the provisional values the first fit replaced, and how they scored.${embedder ? "" : " This run had no embedding model, so the set for candidates with a cosine is not fitted."}`,
    "",
    "## Scorers at T without a model, all repositories",
    "",
    "The candidates as the app proposes them when no embedding model is available.",
    "",
    scorerTable(pooledWithout, withoutScorers),
    "",
  );
  if (embedder) {
    const shared = runs.flatMap((r) =>
      r.test.labeled.filter((l) => withoutModel(l.candidate)),
    );
    lines.push(
      "## Scorers at T with the model, all repositories",
      "",
      "Every candidate, similarity-only ones included, each with its cosine.",
      "",
      scorerTable(
        runs.flatMap((r) => r.test.labeled),
        withScorers,
      ),
      "",
      "### The same, on the pairs both views share",
      "",
      "Co-change and shared-string candidates only: whether the cosine improves the scores of the pairs proposed without it.",
      "",
      scorerTable(shared, withScorers.slice(0, 3)),
      "",
    );
  }
  lines.push(
    "## Model scorers",
    "",
    ...modelSection(runs, model, fittedScorer),
    "",
    "Brier and ECE (10 equal bins): lower is better. ROC AUC: how well the scores rank, apart from calibration (0.5 is chance).",
    "",
    `### Precision and recall by threshold (${primary?.name ?? ""})`,
    "",
  );
  const fittedPooled = metrics(pooled, primary?.p ?? (() => 0));
  lines.push(
    table(
      ["Threshold", "At or above", "Precision", "Recall"],
      fittedPooled.pr.map((p) => [
        num(p.threshold, 2),
        String(p.predicted),
        pctOrDash(p.precision),
        pctOrDash(p.recall),
      ]),
    ),
    "",
    `### Reliability (${primary?.name ?? ""})`,
    "",
    table(
      ["Predicted", "Candidates", "Mean predicted", "Observed"],
      fittedPooled.bins
        .filter((b) => b.n > 0)
        .map((b) => [
          `${num(b.lo, 1)}–${num(b.hi, 1)}`,
          String(b.n),
          num(b.meanP),
          pct(b.rate),
        ]),
    ),
    "",
    `## By repository (${primary?.name ?? ""})`,
    "",
    table(
      [
        "Repository",
        "Judged",
        "Positive rate",
        "Mean p",
        "Brier",
        "ECE",
        "ROC AUC",
        "Precision at 0.5",
        "Recall at 0.5",
      ],
      runs.map((r) => {
        const m = metrics(
          embedder ? r.test.labeled : r.test.labeledWithoutModel,
          primary?.p ?? (() => 0),
        );
        const at = m.pr.find((p) => p.threshold === 0.5);
        return [
          r.name,
          String(m.n),
          pct(m.prevalence),
          num(m.meanP),
          num(m.brier),
          num(m.ece),
          num(m.auc),
          pctOrDash(at?.precision ?? Number.NaN),
          pctOrDash(at?.recall ?? Number.NaN),
        ];
      }),
    ),
    "",
    `## By signal (${primary?.name ?? ""}, all repositories)`,
    "",
  );
  const signals = [...new Set(pooled.map((l) => signalOf(l.candidate)))].sort();
  lines.push(
    table(
      [
        "Signal",
        "Judged",
        "Positive rate",
        "Mean p",
        "Brier",
        "ECE",
        "ROC AUC",
      ],
      signals.map((sig) => {
        const m = metrics(
          pooled.filter((l) => signalOf(l.candidate) === sig),
          primary?.p ?? (() => 0),
        );
        return [
          sig,
          String(m.n),
          pct(m.prevalence),
          num(m.meanP),
          num(m.brier),
          num(m.ece),
          num(m.auc),
        ];
      }),
    ),
    "",
    `## Hint edges at T with the fitted coefficients (floor ${String(HINT_DEFAULTS.floor)}, at most ${String(HINT_DEFAULTS.perNode)} per node)`,
    "",
  );
  const edgeRows = runs.map((r) => {
    const snap = r.test.snapshot;
    const scored: ScoredRelation[] = snap.candidates.map((c) => ({
      source: c.source,
      target: c.target,
      probability: fittedScorer.probability(c.signals),
      rationale: "",
    }));
    const edges = hintEdges(snap.candidates, scored, {
      floor: HINT_DEFAULTS.floor,
      perNode: HINT_DEFAULTS.perNode,
      byModel: false,
      facts: snap.facts,
    });
    const aboveFloor = new Map<string, number>();
    for (const s of scored) {
      if (
        s.probability >= HINT_DEFAULTS.floor &&
        !snap.facts.has(`${s.source}\u0000${s.target}`)
      )
        aboveFloor.set(s.source, (aboveFloor.get(s.source) ?? 0) + 1);
    }
    const capped = [...aboveFloor.values()].filter(
      (n) => n > HINT_DEFAULTS.perNode,
    ).length;
    const judged = new Map(
      r.test.labeled.map((l) => [
        `${l.candidate.source}\u0000${l.candidate.target}`,
        l.y,
      ]),
    );
    const shownJudged = edges.filter((e) =>
      judged.has(`${e.source}\u0000${e.target}`),
    );
    const strong = shownJudged.filter(
      (e) => e.confidence >= HINT_DEFAULTS.threshold,
    );
    const hit = (es: typeof edges) =>
      es.filter((e) => judged.get(`${e.source}\u0000${e.target}`) === 1).length;
    return [
      r.name,
      String(snap.nodeOf.size),
      String(edges.length),
      String(capped),
      `${pctOrDash(hit(shownJudged) / shownJudged.length)} (${String(shownJudged.length)} judged)`,
      `${pctOrDash(hit(strong) / strong.length)} (${String(strong.length)} judged)`,
      `${num(snap.enrichMs, 0)} ms`,
      `${num(snap.analyzeMs / 1000, 1)} s`,
    ];
  });
  lines.push(
    table(
      [
        "Repository",
        "Files mapped",
        "Hint edges",
        "Nodes over the cap",
        "Precision of drawn edges",
        `Precision at ${String(HINT_DEFAULTS.threshold)}+`,
        "Enrich stage",
        "Whole analysis",
      ],
      edgeRows,
    ),
    "",
    `Enrich stage time is the run without a cache: the co-change log is read from git${embedder ? " and every file is embedded" : ""}. With the cache, the commit sets of a HEAD are read once${embedder ? " and a file is embedded once per content and model" : ""}.`,
    "",
  );
  writeReport(path.resolve(values.out), lines.join("\n"));
  process.stderr.write(`wrote ${values.out}\n`);
  const out = values["write-coefficients"];
  if (out !== undefined) {
    const round = (w: HeuristicCoefficients): HeuristicCoefficients => {
      const r = (x: number) => Math.round(x * 1e4) / 1e4;
      return {
        intercept: r(w.intercept),
        cochangeRatio: r(w.cochangeRatio),
        cochangeSupport: r(w.cochangeSupport),
        stringWeight: r(w.stringWeight),
        embeddingCosine: r(w.embeddingCosine),
      };
    };
    fs.writeFileSync(
      path.resolve(out),
      `${JSON.stringify(
        {
          withoutEmbeddings: round(fitted.withoutEmbeddings),
          withEmbeddings: round(fitted.withEmbeddings),
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(`wrote ${out}\n`);
  }
}

main().catch((err: unknown) => {
  // A plan waiting for consent prints as is: nothing was sent.
  process.stderr.write(
    err instanceof ConsentRequired
      ? err.message
      : `${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
