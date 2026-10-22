/**
 * pnpm bench:accuracy <repo>... [--out <file>] [--raw <file>]
 *
 * Measures TS/JS edge precision and recall against dependency-cruiser
 * (PLAN.md M2) on pinned checkouts that are never installed, built or run.
 * dependency-cruiser is driven through its API with options built here: it
 * never loads a .dependency-cruiser config, webpack or babel config from the
 * analyzed repo; its tsconfig reading parses JSON only.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import ts from "typescript";
import { ROOT_KINDS, typescriptAdapter } from "@epoch-dev/adapter-typescript";
import { FsReader, analyze, discover } from "@epoch-dev/engine";
import {
  compareEdges,
  scores,
  type Comparison,
  type EpochImport,
  type ToolDependency,
} from "./edges.js";
import { applyReviews } from "./reviewed.js";
import {
  hostInfo,
  installedVersion,
  pct,
  repoInfo,
  table,
  writeReport,
  type RepoInfo,
} from "./report.js";

interface RepoResult {
  readonly repo: RepoInfo;
  readonly files: number;
  readonly tsconfig: string | null;
  readonly epochMs: number;
  readonly toolMs: number;
  readonly comparison: Comparison;
}

const isSource = (rel: string) =>
  typescriptAdapter.extensions.some((e) => rel.endsWith(e));

async function measure(dir: string): Promise<RepoResult> {
  const repo = repoInfo(dir);
  const epochImports: EpochImport[] = [];
  let t = performance.now();
  const { graph } = await analyze(repo.root, {
    history: false,
    onResolution: (from, imp, res) =>
      epochImports.push({
        from,
        specifier: imp.specifier,
        kind: imp.kind,
        res,
      }),
  });
  const epochMs = performance.now() - t;
  const sources = new Set(
    graph.nodes.filter((n) => isSource(n.id)).map((n) => n.id),
  );

  const found = discover(repo.root, { isSource });
  const roots = typescriptAdapter.detectProjectRoots({
    root: repo.root,
    files: found.files,
    reader: new FsReader(repo.root),
  });
  const workspacePackages = new Set(
    roots
      .filter(
        (r) => r.kind === ROOT_KINDS.workspacePackage && r.name !== undefined,
      )
      .map((r) => r.name ?? ""),
  );

  // The repo's root tsconfig (tsconfig.json, else tsconfig.base.json), read as data.
  const tsconfig =
    ["tsconfig.json", "tsconfig.base.json"].find((f) =>
      fs.existsSync(path.join(repo.root, f)),
    ) ?? null;
  const cwd = process.cwd();
  process.chdir(repo.root);
  t = performance.now();
  let out: ICruiseResult;
  try {
    const result = await cruise(
      [...sources],
      {
        baseDir: repo.root,
        tsPreCompilationDeps: true,
        doNotFollow: { path: "node_modules" },
        outputType: "json",
        ...(tsconfig ? { tsConfig: { fileName: tsconfig } } : {}),
      },
      {},
      tsconfig ? { tsConfig: extractTSConfig(tsconfig) } : {},
    );
    out = (
      typeof result.output === "string"
        ? JSON.parse(result.output)
        : result.output
    ) as ICruiseResult;
  } finally {
    process.chdir(cwd);
  }
  const toolMs = performance.now() - t;

  const toolDependencies: ToolDependency[] = [];
  for (const m of out.modules) {
    for (const d of m.dependencies) {
      const rel = d.resolved.split(path.sep).join("/");
      const inRepo =
        !d.couldNotResolve &&
        !d.coreModule &&
        !rel.startsWith("../") &&
        !path.isAbsolute(rel) &&
        !rel.split("/").includes("node_modules");
      toolDependencies.push({
        from: m.source.split(path.sep).join("/"),
        specifier: d.module,
        resolved: inRepo ? rel : null,
        couldNotResolve: d.couldNotResolve,
        types: d.dependencyTypes,
      });
    }
  }
  // `paths` patterns of every other tsconfig, read as JSON text (never executed).
  const otherAliases: { pattern: string; dir: string }[] = [];
  for (const f of found.files) {
    if (!/(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(f) || f === tsconfig)
      continue;
    const { config } = ts.parseConfigFileTextToJson(
      f,
      fs.readFileSync(path.join(repo.root, f), "utf8"),
    ) as {
      config?: { compilerOptions?: { paths?: Record<string, unknown> } };
    };
    for (const pattern of Object.keys(config?.compilerOptions?.paths ?? {})) {
      const dir = path.posix.dirname(f);
      otherAliases.push({ pattern, dir: dir === "." ? "" : dir });
    }
  }

  const comparison = compareEdges({
    sources,
    epochImports,
    toolDependencies,
    context: {
      workspacePackages,
      otherAliases,
      packages: found.files
        .filter((f) => f === "package.json" || f.endsWith("/package.json"))
        .map((f) => packageFacts(repo.root, f)),
    },
  });
  return {
    repo,
    files: sources.size,
    tsconfig,
    epochMs,
    toolMs,
    comparison: applyReviews(repo.name, comparison),
  };
}

/** Name and `imports` keys of a package.json, read as data. */
function packageFacts(
  root: string,
  file: string,
): { name?: string; dir: string; imports: string[] } {
  const dir =
    file === "package.json" ? "" : file.slice(0, -"/package.json".length);
  let manifest: { name?: unknown; imports?: unknown } = {};
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, file), "utf8"),
    ) as typeof manifest;
  } catch {
    // a malformed manifest carries no name or imports
  }
  const imports =
    typeof manifest.imports === "object" && manifest.imports !== null
      ? Object.keys(manifest.imports)
      : [];
  return typeof manifest.name === "string"
    ? { name: manifest.name, dir, imports }
    : { dir, imports };
}

/** Up to 3 epoch-only "tool wrong" edges per reason, picked with a fixed seed. */
function sampleToolWrong(
  ds: Comparison["disagreements"],
): Comparison["disagreements"][number][] {
  const groups = new Map<string, Comparison["disagreements"][number][]>();
  for (const d of ds) {
    if (d.side !== "epoch-only" || d.verdict !== "tool-wrong") continue;
    groups.set(d.reason, [...(groups.get(d.reason) ?? []), d]);
  }
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return [...groups.values()].flatMap((group) => {
    const pool = [...group];
    const out: Comparison["disagreements"][number][] = [];
    while (out.length < 3 && pool.length > 0)
      out.push(...pool.splice(Math.floor(next() * pool.length), 1));
    return out;
  });
}

function render(results: readonly RepoResult[], toolVersion: string): string {
  const lines: string[] = [
    "# TypeScript/JavaScript edge accuracy",
    "",
    "Generated by `pnpm bench:accuracy` (packages/bench/src/accuracy.ts). Do not edit by hand.",
    "",
    "## Method",
    "",
    `- **Ground truth:** dependency-cruiser ${toolVersion}, through its API with \`tsPreCompilationDeps: true\` (type-only imports count), \`doNotFollow: node_modules\`, and the repository's root \`tsconfig.json\` (else \`tsconfig.base.json\`). It never loads configuration code from the analyzed repository.`,
    "- **Repositories** are pinned shallow clones, never installed, built or run, so there is no `node_modules`.",
    "- **Compared:** file-level physical imports (each import's resolved file, so Epoch's barrel tracing does not enter) from the source files Epoch analyzed, given to both tools as the same list. Imports of npm packages and Node built-ins are not edges on either side.",
    "- **Every disagreement is classified** by explicit rules (packages/bench/src/edges.ts): *tool wrong* (a real edge the tool missed), *Epoch wrong* (Epoch missed or invented an edge), *ambiguous* (left out of the scores) or *unclassified* (counted against Epoch until reviewed).",
    "- **Raw** scores treat the tool as truth. **Adjusted** scores use the reference set: agreed edges plus classified real edges.",
    "- A *tool wrong* verdict says why the tool missed an edge (no node_modules, one tsconfig, …); it accepts Epoch's target as right. Each repository lists a fixed sample of those edges so a reader can trace the targets through package.json `exports`/`imports` and tsconfig `paths`.",
    `- **Host:** ${hostInfo()}.`,
    "",
    "## Results",
    "",
    table(
      [
        "Repository",
        "Commit",
        "Files",
        "Epoch edges",
        "Tool edges",
        "Agreed",
        "Raw precision",
        "Raw recall",
        "Adjusted precision",
        "Adjusted recall",
        "Unclassified",
      ],
      results.map((r) => {
        const s = scores(r.comparison);
        return [
          r.repo.url ?? r.repo.name,
          r.repo.commit?.slice(0, 12) ?? "unknown",
          String(r.files),
          String(r.comparison.epochEdges),
          String(r.comparison.toolEdges),
          String(r.comparison.both),
          pct(s.raw.precision),
          pct(s.raw.recall),
          pct(s.adjusted.precision),
          pct(s.adjusted.recall),
          String(
            r.comparison.disagreements.filter(
              (d) => d.verdict === "unclassified",
            ).length,
          ),
        ];
      }),
    ),
    "",
  ];
  for (const r of results) {
    lines.push(
      `## ${r.repo.name}`,
      "",
      `Commit \`${r.repo.commit ?? "unknown"}\`, tool tsconfig: ${r.tsconfig ?? "none"}. Epoch ${(r.epochMs / 1000).toFixed(2)} s, tool ${(r.toolMs / 1000).toFixed(2)} s (one run each, not a benchmark).`,
      "",
    );
    const groups = new Map<
      string,
      (typeof r.comparison.disagreements)[number][]
    >();
    for (const d of r.comparison.disagreements) {
      const key = `${d.side}\u0000${d.verdict}\u0000${d.reason}`;
      groups.set(key, [...(groups.get(key) ?? []), d]);
    }
    const rows = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, ds]) => {
        const [side = "", verdict = "", reason = ""] = key.split("\u0000");
        const ex = ds[0];
        const example = ex
          ? `${ex.from} → ${ex.to} (${ex.specifiers.join(", ")})`
          : "";
        return [String(ds.length), side, verdict, reason, example];
      });
    lines.push(
      rows.length
        ? table(["Count", "Only in", "Verdict", "Reason", "Example"], rows)
        : "No disagreements.",
      "",
    );
    const sample = sampleToolWrong(r.comparison.disagreements);
    if (sample.length > 0) {
      lines.push(
        "Sample of *tool wrong* edges to check by hand (up to 3 per reason, fixed seed):",
        "",
        table(
          ["Reason", "From", "Specifier", "Epoch's target"],
          sample.map((d) => [d.reason, d.from, d.specifiers.join(", "), d.to]),
        ),
        "",
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      out: { type: "string", default: "docs/benchmarks/typescript.md" },
      raw: { type: "string" },
    },
    allowPositionals: true,
  });
  if (positionals.length === 0) {
    process.stderr.write(
      "usage: pnpm bench:accuracy <repo>... [--out <file>] [--raw <file>]\n",
    );
    process.exitCode = 1;
    return;
  }
  const results: RepoResult[] = [];
  for (const dir of positionals) {
    process.stderr.write(`measuring ${dir}...\n`);
    results.push(await measure(dir));
  }
  const toolVersion = installedVersion(
    "dependency-cruiser",
    "dependency-cruiser",
  );
  writeReport(path.resolve(values.out), render(results, toolVersion));
  if (values.raw)
    writeReport(path.resolve(values.raw), JSON.stringify(results, null, 2));
  for (const r of results) {
    const s = scores(r.comparison);
    process.stderr.write(
      `${r.repo.name}: agreed ${String(r.comparison.both)}, raw P ${pct(s.raw.precision)} R ${pct(s.raw.recall)}, adjusted P ${pct(s.adjusted.precision)} R ${pct(s.adjusted.recall)}\n`,
    );
  }
}

await main();
