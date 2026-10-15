/**
 * pnpm bench:findings <repo>... [--knip <repo>=<knip.json>]... [--hindsight-days 365]
 *                     [--sample 50] [--out docs/benchmarks/findings.md]
 *                     [--csv docs/benchmarks/findings-review.csv]
 *
 * The M5 evaluation (PLAN.md "Evaluation protocol"), on pinned full clones:
 * - what the detectors report per repository, and what the Findings stage
 *   costs with a cold and a warm cache (git history lookups included);
 * - unreachable-file against knip's unused files, where a knip JSON report
 *   is given (knip runs separately, in a scratch install, on the pinned
 *   clone only: it loads project configuration, ADR-006); every
 *   disagreement gets a category;
 * - a hindsight test: findings at a commit about a year back, checked
 *   against HEAD (was the file deleted?), next to the rate for files that
 *   were not flagged; a proxy, stated as one;
 * - a review sheet: a stratified sample of High and Medium findings with
 *   links to the exact commit and an empty verdict column for a person to
 *   fill. bench:findings:score turns the verdicts into precision.
 */
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import ts from "typescript";
import {
  CONFIDENCE_LABELS,
  globMatcher,
  type Confidence,
  type Finding,
  type FindingKind,
  type Graph,
} from "@epoch-dev/core";
import { typescriptAdapter } from "@epoch-dev/adapter-typescript";
import {
  DEFAULT_REGISTRATIONS,
  analyze,
  openCache,
  type AnalyzeResult,
} from "@epoch-dev/engine";
import {
  hostInfo,
  pct,
  repoInfo,
  table,
  writeReport,
  type RepoInfo,
} from "./report.js";

const KINDS: readonly FindingKind[] = [
  "dead-branch",
  "stale-flag",
  "unreachable-file",
];
const LEVELS: readonly Confidence[] = ["high", "medium", "low"];
const TS_SOURCE = /\.(?:[cm]?[jt]sx?)$/;

interface Run {
  readonly repo: RepoInfo;
  readonly result: AnalyzeResult;
  readonly coldMs: number;
  readonly warmMs: number;
  readonly coldFindingsMs: number;
  readonly warmFindingsMs: number;
}

const git = (cwd: string, ...args: string[]): string =>
  childProcess.execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "--no-pager", ...args],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );

/** "owner/name" from a GitHub origin URL, else the folder name. */
function displayName(repo: RepoInfo): string {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(repo.url ?? "");
  return m?.[1] ?? repo.name;
}

/** Analyzes twice with a fresh cache: the first run is cold, the second warm (same HEAD). */
async function measure(dir: string): Promise<Run> {
  const cacheDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "epoch-bench-findings-"),
  );
  const cache = openCache(cacheDir);
  try {
    let t = performance.now();
    const cold = await analyze(dir, { cache });
    const coldMs = performance.now() - t;
    t = performance.now();
    const warm = await analyze(dir, { cache });
    const warmMs = performance.now() - t;
    const info = repoInfo(dir);
    return {
      repo: { ...info, name: displayName(info) },
      result: warm,
      coldMs,
      warmMs,
      coldFindingsMs: cold.meta.timingsMs.findings,
      warmFindingsMs: warm.meta.timingsMs.findings,
    };
  } finally {
    cache.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

const count = (fs_: readonly Finding[], kind: FindingKind, level: Confidence) =>
  fs_.filter((f) => f.kind === kind && f.confidence === level).length;

/** Repo-relative paths the graph analyzed (source files, and Go package members). */
function analyzedFiles(result: AnalyzeResult): Set<string> {
  return new Set(
    result.graph.nodes.filter((n) => n.kind === "file").map((n) => n.id),
  );
}

interface KnipRow {
  readonly file: string;
  readonly side: "both" | "epoch-only" | "knip-only";
  readonly confidence?: Confidence;
  readonly category: string;
}

interface KnipConfig {
  readonly ignoreWorkspaces?: string[];
  readonly ignoreIssues?: Record<string, string[]>;
  readonly ignore?: string | string[];
  readonly entry?: string | string[];
  readonly workspaces?: Record<
    string,
    { entry?: string | string[]; ignore?: string | string[] }
  >;
}

const list = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];
const under = (dir: string, p: string) =>
  dir === "." || dir === "" ? p : `${dir}/${p}`;

/** Why knip's own configuration (knip.json or knip.jsonc at the root) counts a file as used, if it does. */
function knipConfigReason(root: string): (file: string) => string | undefined {
  const name = ["knip.json", "knip.jsonc"].find((n) =>
    fs.existsSync(path.join(root, n)),
  );
  if (name === undefined) return () => undefined;
  const { config } = ts.parseConfigFileTextToJson(
    name,
    fs.readFileSync(path.join(root, name), "utf8"),
  ) as {
    config?: KnipConfig;
  };
  if (!config) return () => undefined;
  const ignoredWs = globMatcher(list(config.ignoreWorkspaces));
  const ignoredFiles = globMatcher([
    ...list(config.ignore),
    ...Object.entries(config.ignoreIssues ?? {})
      .filter(([, kinds]) => kinds.includes("files"))
      .map(([glob]) => glob),
  ]);
  const entries = globMatcher([
    ...list(config.entry),
    ...Object.entries(config.workspaces ?? {}).flatMap(([dir, ws]) =>
      list(ws.entry).map((e) => under(dir, e)),
    ),
  ]);
  return (file) => {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (ignoredWs(parts.slice(0, i).join("/")))
        return "outside knip's scope (its config ignores the workspace)";
    }
    if (entries(file))
      return "an entry declared in the repository's knip config (loaded by tooling)";
    if (ignoredFiles(file)) return "knip's config tells it to ignore the file";
    return undefined;
  };
}

/** Epoch's unreachable files against knip's unused files, each disagreement with a category. */
function compareKnip(result: AnalyzeResult, knipFile: string): KnipRow[] {
  const configReason = knipConfigReason(result.root);
  const report = JSON.parse(fs.readFileSync(knipFile, "utf8")) as {
    issues: { files?: { name: string }[] }[];
  };
  const knip = new Set(
    report.issues.flatMap((i) => (i.files ?? []).map((f) => f.name)),
  );
  const epoch = new Map<string, Confidence>();
  for (const f of result.graph.findings) {
    if (f.kind !== "unreachable-file") continue;
    for (const l of f.locations) epoch.set(l.file, f.confidence);
  }
  const analyzed = analyzedFiles(result);
  const roots = new Map<string, string>();
  for (const r of result.graph.roots)
    if (!roots.has(r.file)) roots.set(r.file, r.reason);
  const generated = new Set(
    result.graph.nodes.filter((n) => n.loc === 0).map((n) => n.id),
  );
  const rows: KnipRow[] = [];
  for (const file of [...new Set([...knip, ...epoch.keys()])].sort()) {
    const inKnip = knip.has(file);
    const confidence = epoch.get(file);
    if (inKnip && confidence !== undefined) {
      rows.push({ file, side: "both", confidence, category: "agree" });
    } else if (inKnip) {
      const category = !TS_SOURCE.test(file)
        ? "not a JS/TS source file (Epoch analyzes none)"
        : !analyzed.has(file)
          ? "not analyzed by Epoch (ignored, too large or skipped)"
          : typescriptAdapter.isTestFile(file)
            ? "test code: a root for Epoch, never reported"
            : /\.d\.[cm]?ts$/.test(file)
              ? "declaration file: never reported"
              : roots.has(file)
                ? `an entry point for Epoch (${roots.get(file) ?? ""})`
                : generated.has(file)
                  ? "empty or generated"
                  : "reached by Epoch from an entry point";
      rows.push({ file, side: "knip-only", category });
    } else if (confidence !== undefined) {
      rows.push({
        file,
        side: "epoch-only",
        confidence,
        category:
          configReason(file) ??
          "knip counts it as used without its config naming it (a plugin or a reference Epoch does not follow)",
      });
    }
  }
  return rows;
}

interface Hindsight {
  readonly then: string;
  readonly thenDate: string;
  readonly byLevel: ReadonlyMap<Confidence, { flagged: number; gone: number }>;
  readonly unflagged: { files: number; gone: number };
  /** stale-flag candidates then, and how many have no usage left at HEAD. */
  readonly flags: ReadonlyMap<Confidence, { flagged: number; gone: number }>;
}

/** Findings at a commit `days` before HEAD; how many of their files are gone at HEAD. */
async function hindsight(
  dir: string,
  days: number,
): Promise<Hindsight | undefined> {
  const headTime = Number(git(dir, "log", "-1", "--format=%ct", "HEAD").trim());
  const before = new Date((headTime - days * 86_400) * 1000).toISOString();
  const then = git(dir, "rev-list", "-1", `--before=${before}`, "HEAD").trim();
  if (then === "") return undefined;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-bench-hindsight-"));
  try {
    git(os.tmpdir(), "clone", "-q", "--shared", "--no-checkout", dir, tmp);
    git(tmp, "checkout", "-q", then);
    const { graph } = await analyze(tmp);
    const atHead = new Set(
      git(dir, "ls-tree", "-r", "--name-only", "HEAD").split("\n"),
    );
    const byLevel = new Map<Confidence, { flagged: number; gone: number }>();
    const flagged = new Set<string>();
    for (const f of graph.findings) {
      if (f.kind !== "unreachable-file") continue;
      const s = byLevel.get(f.confidence) ?? { flagged: 0, gone: 0 };
      for (const l of f.locations) {
        flagged.add(l.file);
        s.flagged++;
        if (!atHead.has(l.file)) s.gone++;
      }
      byLevel.set(f.confidence, s);
    }
    const flags = new Map<Confidence, { flagged: number; gone: number }>();
    for (const f of graph.findings) {
      if (f.kind !== "stale-flag") continue;
      const s = flags.get(f.confidence) ?? { flagged: 0, gone: 0 };
      s.flagged++;
      const files = [...new Set(f.locations.map((l) => l.file))].filter((p) =>
        atHead.has(p),
      );
      let still = false;
      if (files.length > 0) {
        try {
          // A fixed-string search (-F) at HEAD, in the files that used it.
          git(
            dir,
            "grep",
            "-q",
            "-F",
            "-e",
            f.subject.name,
            "HEAD",
            "--",
            ...files,
          );
          still = true;
        } catch {
          still = false; // git grep exits 1 when nothing matches
        }
      }
      if (!still) s.gone++;
      flags.set(f.confidence, s);
    }
    const others = sourceFiles(
      git(tmp, "ls-tree", "-r", "--name-only", "HEAD").split("\n"),
    ).filter((f) => !flagged.has(f));
    return {
      then,
      thenDate: git(dir, "log", "-1", "--format=%cs", then).trim(),
      byLevel,
      flags,
      unflagged: {
        files: others.length,
        gone: others.filter((f) => !atHead.has(f)).length,
      },
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Source files the adapters analyze, test code excepted (the population findings come from). */
function sourceFiles(files: readonly string[]): string[] {
  return files.filter((f) => {
    const reg = DEFAULT_REGISTRATIONS.find(
      (r) => r.grammarFor(f) !== undefined,
    );
    return (
      reg !== undefined &&
      !reg.adapter.isTestFile(f) &&
      !/\.d\.[cm]?ts$|\.pyi$/.test(f)
    );
  });
}

const csvCell = (s: string): string =>
  /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

function githubLink(repo: RepoInfo, f: Finding): string {
  const base = (repo.url ?? "")
    .replace(/\.git$/, "")
    .replace(/^git@github\.com:/, "https://github.com/");
  const l = f.locations[0];
  if (base === "" || repo.commit === null || l === undefined) return "";
  const lines =
    l.line === undefined
      ? ""
      : `#L${String(l.line)}${l.endLine !== undefined && l.endLine !== l.line ? `-L${String(l.endLine)}` : ""}`;
  return `${base}/blob/${repo.commit}/${l.file}${lines}`;
}

function languageOf(graph: Graph, f: Finding): string {
  const file = f.locations[0]?.file ?? "";
  const node = graph.nodes.find((n) => n.id === file);
  if (node) return node.language;
  if (file.endsWith(".go")) return "go";
  if (file.endsWith(".py")) return "python";
  return "unknown";
}

/**
 * Up to `size` High and Medium findings, stratified by (repository, kind,
 * confidence) with equal allocation: each stratum gets an equal share, a
 * stratum smaller than its share gives the rest to the others (water
 * filling), so small strata are reviewed in full and no single repository
 * dominates. Within a stratum the order is a hash of the id, so the sample
 * is reproducible and not biased by file names.
 */
function sample(runs: readonly Run[], size: number) {
  const strata = new Map<string, { run: Run; findings: Finding[] }>();
  for (const run of runs) {
    for (const f of run.result.graph.findings) {
      if (f.confidence === "low") continue;
      const key = `${run.repo.name}\u0000${f.kind}\u0000${f.confidence}`;
      const s = strata.get(key) ?? { run, findings: [] };
      s.findings.push(f);
      strata.set(key, s);
    }
  }
  const keys = [...strata.keys()].sort();
  const quota = new Map<string, number>();
  let left = size;
  let open = [...keys];
  while (open.length > 0 && left > 0) {
    const share = Math.floor(left / open.length);
    const small = open.filter(
      (k) => (strata.get(k)?.findings.length ?? 0) <= share,
    );
    if (small.length === 0) {
      // Every remaining stratum can fill its share; spread the remainder in key order.
      open.forEach((k, i) =>
        quota.set(k, share + (i < left - share * open.length ? 1 : 0)),
      );
      left = 0;
      break;
    }
    for (const k of small) {
      const n = strata.get(k)?.findings.length ?? 0;
      quota.set(k, n);
      left -= n;
    }
    open = open.filter((k) => !small.includes(k));
  }
  const hash = (id: string) => createHash("sha256").update(id).digest("hex");
  const picked: { run: Run; finding: Finding }[] = [];
  for (const k of keys) {
    const s = strata.get(k);
    if (!s) continue;
    const order = [...s.findings].sort((a, b) =>
      hash(a.id) < hash(b.id) ? -1 : 1,
    );
    for (const finding of order.slice(0, quota.get(k) ?? 0))
      picked.push({ run: s.run, finding });
  }
  return picked;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      knip: { type: "string", multiple: true, default: [] },
      "hindsight-days": { type: "string", default: "365" },
      sample: { type: "string", default: "50" },
      out: { type: "string", default: "docs/benchmarks/findings.md" },
      csv: { type: "string", default: "docs/benchmarks/findings-review.csv" },
    },
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    process.stderr.write(
      "usage: pnpm bench:findings <repo>... [--knip <repo>=<knip.json>]\n",
    );
    process.exitCode = 1;
    return;
  }
  const knipFor = new Map(
    values.knip.map((k) => {
      const i = k.indexOf("=");
      return [k.slice(0, i), k.slice(i + 1)] as const;
    }),
  );
  const runs: Run[] = [];
  const hind: { repo: RepoInfo; h: Hindsight | undefined }[] = [];
  for (const dir of positionals) {
    process.stderr.write(`analyzing ${dir}...\n`);
    const run = await measure(dir);
    runs.push(run);
    process.stderr.write(`hindsight ${dir}...\n`);
    hind.push({
      repo: run.repo,
      h: await hindsight(dir, Number(values["hindsight-days"])),
    });
  }

  const lines: string[] = [];
  lines.push(
    "# Findings evaluation (M5)",
    "",
    "Generated by `pnpm bench:findings`. Findings are candidates for review, never verdicts: these numbers describe how the detectors behave on real repositories, and precision comes only from the human review below.",
    "",
    `Host: ${hostInfo()}.`,
    "",
    "## Repositories",
    "",
    table(
      [
        "Repository",
        "Commit",
        "Files",
        "History",
        "Analysis cold / warm",
        "Findings stage cold / warm",
      ],
      runs.map((r) => [
        r.repo.name,
        r.repo.commit?.slice(0, 12) ?? "?",
        String(r.result.meta.counts.filesAnalyzed),
        r.result.meta.findings.history,
        `${(r.coldMs / 1000).toFixed(1)} s / ${(r.warmMs / 1000).toFixed(1)} s`,
        `${(r.coldFindingsMs / 1000).toFixed(2)} s / ${(r.warmFindingsMs / 1000).toFixed(2)} s`,
      ]),
    ),
    "",
    "Each repository is analyzed twice with a fresh cache: the cold run pays for every git history lookup, the warm run (same HEAD) reads them from the cache.",
    "",
    "## What the detectors report",
    "",
    table(
      [
        "Repository",
        ...KINDS.flatMap((k) =>
          LEVELS.map((l) => `${k} ${CONFIDENCE_LABELS[l]}`),
        ),
      ],
      runs.map((r) => [
        r.repo.name,
        ...KINDS.flatMap((k) =>
          LEVELS.map((l) => String(count(r.result.graph.findings, k, l))),
        ),
      ]),
    ),
    "",
  );
  const frameworks = runs.flatMap((r) =>
    r.result.meta.findings.frameworks.map(
      (f) => `${r.repo.name}: ${f.name}${f.dir === "" ? "" : ` in ${f.dir}`}`,
    ),
  );
  if (frameworks.length > 0)
    lines.push(`Frameworks detected: ${frameworks.join("; ")}.`, "");

  for (const run of runs) {
    const knipFile = knipFor.get(run.repo.name);
    if (knipFile === undefined) continue;
    const rows = compareKnip(run.result, knipFile);
    const by = (side: KnipRow["side"]) => rows.filter((r) => r.side === side);
    const categories = new Map<string, number>();
    for (const r of rows.filter((x) => x.side !== "both")) {
      const k = `${r.side}: ${r.category}`;
      categories.set(k, (categories.get(k) ?? 0) + 1);
    }
    lines.push(
      `## unreachable-file vs knip: ${run.repo.name}`,
      "",
      `knip 6.38.0 \`--include files\`, run on the same commit with the repository's own knip configuration (if any) and its dependencies installed without lifecycle scripts.`,
      "",
      table(
        ["", "Files"],
        [
          ["Both report it", String(by("both").length)],
          ...LEVELS.map((l) => [
            `Only Epoch (${CONFIDENCE_LABELS[l]})`,
            String(by("epoch-only").filter((r) => r.confidence === l).length),
          ]),
          ["Only knip", String(by("knip-only").length)],
        ],
      ),
      "",
      "Disagreements by category:",
      "",
      table(
        ["Category", "Files"],
        [...categories]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => [k, String(n)]),
      ),
      "",
    );
  }

  lines.push(
    "## Hindsight",
    "",
    `Files Epoch reported as possibly unused at a commit about ${values["hindsight-days"]} days before HEAD, and how many no longer exist at HEAD, next to the same rate for files it did not report. A deletion is a proxy for "it really was unused", and a rename counts as a deletion here.`,
    "",
    table(
      [
        "Repository",
        "Then",
        ...LEVELS.map((l) => `${CONFIDENCE_LABELS[l]}: gone / reported`),
        "Not reported: gone / files",
      ],
      hind.map(({ repo, h }) =>
        h === undefined
          ? [repo.name, "no commit that old", ...LEVELS.map(() => "–"), "–"]
          : [
              repo.name,
              `${h.then.slice(0, 12)} (${h.thenDate})`,
              ...LEVELS.map((l) => {
                const s = h.byLevel.get(l);
                return s === undefined || s.flagged === 0
                  ? "0 / 0"
                  : `${String(s.gone)} / ${String(s.flagged)} (${pct(s.gone / s.flagged)})`;
              }),
              `${String(h.unflagged.gone)} / ${String(h.unflagged.files)} (${pct(h.unflagged.gone / Math.max(1, h.unflagged.files))})`,
            ],
      ),
    ),
    "",
  );

  lines.push(
    "Possibly stale flags reported at that commit, and how many have no usage left at HEAD in the files that used them (removed, or rewritten):",
    "",
    table(
      [
        "Repository",
        ...LEVELS.map((l) => `${CONFIDENCE_LABELS[l]}: gone / reported`),
      ],
      hind.map(({ repo, h }) => [
        repo.name,
        ...LEVELS.map((l) => {
          const s = h?.flags.get(l);
          return s === undefined || s.flagged === 0
            ? "0 / 0"
            : `${String(s.gone)} / ${String(s.flagged)}`;
        }),
      ]),
    ),
    "",
  );

  const picked = sample(runs, Number(values.sample));
  const header = [
    "n",
    "id",
    "repository",
    "commit",
    "language",
    "kind",
    "confidence",
    "caps",
    "subject",
    "link",
    "evidence",
    "caveats",
    "verdict",
    "note",
  ];
  const csv = [
    header.join(","),
    ...picked.map(({ run, finding: f }, i) =>
      [
        String(i + 1),
        f.id,
        run.repo.name,
        run.repo.commit ?? "",
        languageOf(run.result.graph, f),
        f.kind,
        f.confidence,
        f.caps.join(" "),
        f.subject.name,
        githubLink(run.repo, f),
        f.evidence.join(" | "),
        f.caveats.join(" | "),
        "",
        "",
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  writeReport(values.csv, csv.join("\n"));
  lines.push(
    "## Review sheet",
    "",
    `\`${values.csv}\` holds ${String(picked.length)} High and Medium findings, stratified by repository, kind and confidence with equal allocation (small strata in full, the rest shared equally; order within a stratum by a hash of the id). Fill \`verdict\` with \`yes\` (it really is unused or never runs), \`no\` (a false positive) or \`unsure\`, then run \`pnpm bench:findings:score\`.`,
    "",
    table(
      ["Stratum", "In sample", "Available"],
      [
        ...new Set(
          picked.map(
            (p) =>
              `${p.run.repo.name} ${p.finding.kind} ${p.finding.confidence}`,
          ),
        ),
      ].map((k) => [
        k,
        String(
          picked.filter(
            (p) =>
              `${p.run.repo.name} ${p.finding.kind} ${p.finding.confidence}` ===
              k,
          ).length,
        ),
        String(
          runs
            .flatMap((r) =>
              r.result.graph.findings.map(
                (f) => `${r.repo.name} ${f.kind} ${f.confidence}`,
              ),
            )
            .filter((x) => x === k).length,
        ),
      ]),
    ),
    "",
  );
  writeReport(values.out, lines.join("\n"));
  process.stderr.write(`wrote ${values.out} and ${values.csv}\n`);
}

await main();
