/**
 * pnpm bench:accuracy <repo>... [--out <file>] [--raw <file>]
 *
 * Measures TS/JS edge precision and recall against dependency-cruiser
 * (PLAN.md M2) on pinned checkouts that are never installed, built or run.
 * dependency-cruiser is driven through its API with options built here: it
 * never loads a .dependency-cruiser config, webpack or babel config from the
 * analyzed repo; its tsconfig reading parses JSON only.
 *
 * The tool works on a scratch copy set up the way the repository sets itself
 * up (ADR-006, benchmark references): its workspace packages linked into
 * node_modules, each file cruised with the tsconfig that owns it, and that
 * tsconfig's customConditions as export conditions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import ts from "typescript";
import { typescriptAdapter } from "@epoch-dev/adapter-typescript";
import { analyze, discover } from "@epoch-dev/engine";
import {
  compareEdges,
  scores,
  type Comparison,
  type EpochImport,
  type ToolDependency,
} from "./edges.js";
import {
  nearestTsconfig,
  pnpmWorkspaceGlobs,
  workspaceGlobs,
} from "./reference.js";
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
  /** The root tsconfig, for files no nearer tsconfig.json includes. */
  readonly tsconfig: string | null;
  /** How many tsconfigs the files were cruised with, and how many files fell back to the root one. */
  readonly tsconfigs: number;
  readonly fallbackFiles: number;
  readonly workspacePackages: number;
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
  const lines = new Map<string, readonly string[]>();
  /** Whether a dynamic import's call loads a file by path rather than import()ing it. */
  const isRuntimePath = (from: string, line: number): boolean => {
    let text = lines.get(from);
    if (text === undefined) {
      text = fs.readFileSync(path.join(repo.root, from), "utf8").split("\n");
      lines.set(from, text);
    }
    // The call's first lines: `resolve(\n  import.meta.dirname, ...` spans lines.
    return RUNTIME_PATH.test(text.slice(line - 1, line + 2).join("\n"));
  };
  const { graph } = await analyze(repo.root, {
    history: false,
    onResolution: (from, imp, res) =>
      epochImports.push({
        from,
        specifier: imp.specifier,
        kind: imp.kind,
        res,
        ...(imp.kind === "dynamic" && isRuntimePath(from, imp.line)
          ? { runtimePath: true }
          : {}),
      }),
  });
  const epochMs = performance.now() - t;
  const sources = new Set(
    graph.nodes.filter((n) => isSource(n.id)).map((n) => n.id),
  );

  const found = discover(repo.root, { isSource });
  const workspacePackages = readWorkspacePackages(repo.root);

  // The repo's root tsconfig (tsconfig.json, else tsconfig.base.json), read as data.
  const tsconfig =
    ["tsconfig.json", "tsconfig.base.json"].find((f) =>
      fs.existsSync(path.join(repo.root, f)),
    ) ?? null;

  const copy = referenceCopy(repo.root, workspacePackages);
  const cwd = process.cwd();
  t = performance.now();
  const toolDependencies: ToolDependency[] = [];
  let groups: Map<string | null, string[]>;
  try {
    groups = groupByTsconfig(copy, [...sources], tsconfig);
    process.chdir(copy);
    for (const [config, files] of groups) {
      const abs = config === null ? undefined : path.join(copy, config);
      const conditions =
        abs === undefined ? [] : (parsedTsconfig(abs)?.customConditions ?? []);
      const result = await cruise(
        files,
        {
          baseDir: copy,
          tsPreCompilationDeps: true,
          doNotFollow: { path: "node_modules" },
          // No depth limit: with one, a file of the group that another one
          // imports is visited first as a dependency, and its own imports are
          // never read. Modules outside the group are dropped below.
          outputType: "json",
          ...(abs ? { tsConfig: { fileName: abs } } : {}),
        },
        {
          exportsFields: ["exports"],
          conditionNames: [...conditions, ...DEFAULT_CONDITIONS],
        },
        abs ? { tsConfig: extractTSConfig(abs) } : {},
      );
      const out = (
        typeof result.output === "string"
          ? JSON.parse(result.output)
          : result.output
      ) as ICruiseResult;
      const own = new Set(files);
      for (const m of out.modules) {
        const from = m.source.split(path.sep).join("/");
        if (!own.has(from)) continue;
        for (const d of m.dependencies) {
          const rel = d.resolved.split(path.sep).join("/");
          const inRepo =
            !d.couldNotResolve &&
            !d.coreModule &&
            !rel.startsWith("../") &&
            !path.isAbsolute(rel) &&
            !rel.split("/").includes("node_modules");
          toolDependencies.push({
            from,
            specifier: d.module,
            resolved: inRepo ? rel : null,
            couldNotResolve: d.couldNotResolve,
            types: d.dependencyTypes,
          });
        }
      }
    }
  } finally {
    process.chdir(cwd);
    fs.rmSync(copy, { recursive: true, force: true });
  }
  const toolMs = performance.now() - t;

  // `paths` patterns of every tsconfig, parsed by TypeScript (extends
  // followed, so an inherited baseUrl counts; nothing executed).
  const aliases: { pattern: string; dir: string; baseUrl: boolean }[] = [];
  for (const f of found.files) {
    if (!/(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(f)) continue;
    const config = ts.getParsedCommandLineOfConfigFile(
      path.join(repo.root, f),
      undefined,
      { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
    );
    const dir = path.posix.dirname(f);
    for (const pattern of Object.keys(config?.options.paths ?? {})) {
      aliases.push({
        pattern,
        dir: dir === "." ? "" : dir,
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated in TS 6, still honoured by its resolver
        baseUrl: config?.options.baseUrl !== undefined,
      });
    }
  }

  const comparison = compareEdges({
    sources,
    epochImports,
    toolDependencies,
    context: {
      workspacePackages,
      aliases,
      packages: found.files
        .filter((f) => f === "package.json" || f.endsWith("/package.json"))
        .map((f) => packageFacts(repo.root, f)),
    },
  });
  return {
    repo,
    files: sources.size,
    tsconfig,
    tsconfigs: [...groups.keys()].filter((k) => k !== null).length,
    fallbackFiles:
      tsconfig === null
        ? (groups.get(null)?.length ?? 0)
        : [...groups.entries()]
            .filter(([k]) => k === tsconfig || k === null)
            .reduce((n, [, f]) => n + f.length, 0),
    workspacePackages: workspacePackages.size,
    epochMs,
    toolMs,
    comparison: applyReviews(repo.name, comparison),
  };
}

/** APIs that load a file by path at run time, as they appear on its line. */
const RUNTIME_PATH =
  /import\.meta\.url|import\.meta\.resolve|require\.resolve|__dirname|import\.meta\.dirname/;

/** Export conditions TypeScript applies besides a tsconfig's customConditions. */
const DEFAULT_CONDITIONS = ["types", "import", "require", "node", "default"];

const readJson = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Workspace packages by name, from the root package.json `workspaces` and
 * pnpm-workspace.yaml `packages` globs (read as data, expanded with
 * fs.globSync), with each one's directory and `exports`.
 */
function readWorkspacePackages(
  root: string,
): Map<string, { dir: string; exports: unknown }> {
  const yamlFile = path.join(root, "pnpm-workspace.yaml");
  const globs = [
    ...workspaceGlobs(readJson(path.join(root, "package.json"))),
    ...(fs.existsSync(yamlFile)
      ? pnpmWorkspaceGlobs(fs.readFileSync(yamlFile, "utf8"))
      : []),
  ];
  const include = globs.filter((g) => !g.startsWith("!"));
  const exclude = [
    "**/node_modules/**",
    ...globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1)),
  ];
  const out = new Map<string, { dir: string; exports: unknown }>();
  for (const glob of include) {
    const manifests = fs.globSync(`${glob.replace(/\/+$/, "")}/package.json`, {
      cwd: root,
      exclude: (f: string) => exclude.some((x) => path.matchesGlob(f, x)),
    });
    for (const manifest of [...manifests].sort()) {
      const rel = manifest.split(path.sep).join("/");
      const pkg = readJson(path.join(root, rel));
      if (typeof pkg.name !== "string" || out.has(pkg.name)) continue;
      out.set(pkg.name, {
        dir: path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel),
        exports: pkg.exports,
      });
    }
  }
  return out;
}

/**
 * A scratch copy of the checkout (without .git) whose root node_modules links
 * each workspace package, as npm and Yarn workspaces link them. Nothing is
 * installed or run; the pinned checkout itself is left untouched.
 */
function referenceCopy(
  root: string,
  workspacePackages: ReadonlyMap<string, { dir: string }>,
): string {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-bench-reference-"));
  fs.cpSync(root, copy, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => path.basename(src) !== ".git",
  });
  for (const [name, { dir }] of workspacePackages) {
    const link = path.join(copy, "node_modules", ...name.split("/"));
    if (fs.existsSync(link)) continue;
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(
      path.relative(path.dirname(link), path.join(copy, dir)),
      link,
    );
  }
  return copy;
}

const parsed = new Map<
  string,
  { files: ReadonlySet<string>; customConditions: string[] } | undefined
>();

/** A tsconfig parsed by TypeScript (extends followed, include globs expanded), cached. */
function parsedTsconfig(
  abs: string,
): { files: ReadonlySet<string>; customConditions: string[] } | undefined {
  if (parsed.has(abs)) return parsed.get(abs);
  const config = ts.getParsedCommandLineOfConfigFile(abs, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  });
  const value = config
    ? {
        files: new Set(config.fileNames.map((f) => path.resolve(f))),
        customConditions: config.options.customConditions ?? [],
      }
    : undefined;
  parsed.set(abs, value);
  return value;
}

/**
 * Files grouped by the tsconfig that owns them (the closest tsconfig.json
 * that includes the file); the rest go with the root tsconfig, or null.
 */
function groupByTsconfig(
  copy: string,
  files: readonly string[],
  rootTsconfig: string | null,
): Map<string | null, string[]> {
  const groups = new Map<string | null, string[]>();
  for (const file of [...files].sort()) {
    const owner =
      nearestTsconfig(
        file,
        (c) => fs.existsSync(path.join(copy, c)),
        (c, f) =>
          parsedTsconfig(path.join(copy, c))?.files.has(path.join(copy, f)) ===
          true,
      ) ?? rootTsconfig;
    const group = groups.get(owner);
    if (group) group.push(file);
    else groups.set(owner, [file]);
  }
  return groups;
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
    `- **Ground truth:** dependency-cruiser ${toolVersion}, through its API with \`tsPreCompilationDeps: true\` (type-only imports count) and \`doNotFollow: node_modules\`. It never loads configuration code from the analyzed repository.`,
    "- **Set up as the repository sets itself up** (ADR-006): the tool runs on a scratch copy whose root `node_modules` links each workspace package (from the root `package.json` `workspaces` and `pnpm-workspace.yaml`, as npm and Yarn workspaces link them). Each file is cruised with the tsconfig that owns it (the closest `tsconfig.json` that includes it, else the root `tsconfig.json` or `tsconfig.base.json`), and that tsconfig's `customConditions` are export conditions, next to TypeScript's own (types, import, require, node, default).",
    "- **Repositories** are pinned clones, never installed, built or run: third-party packages are absent, and build output exists only where it is committed.",
    "- **Compared:** file-level physical imports (each import's resolved file, so Epoch's barrel tracing does not enter) from the source files Epoch analyzed, given to both tools as the same list. Imports of npm packages and Node built-ins are not edges on either side.",
    "- **Every disagreement is classified** by explicit rules (packages/bench/src/edges.ts): *tool wrong* (a real edge the tool missed), *Epoch wrong* (Epoch missed or invented an edge), *ambiguous* (left out of the scores) or *unclassified* (counted against Epoch until reviewed).",
    "- **Raw** scores treat the tool as truth. **Adjusted** scores use the reference set: agreed edges plus classified real edges.",
    "- A *tool wrong* verdict says why the tool missed an edge (build output that is not there, …); it accepts Epoch's target as right. Each repository lists a fixed sample of those edges so a reader can trace the targets through package.json `exports`/`imports` and tsconfig `paths`.",
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
      `Commit \`${r.repo.commit ?? "unknown"}\`. The tool ran with ${String(r.workspacePackages)} workspace packages linked and ${String(r.tsconfigs)} tsconfigs; ${String(r.fallbackFiles)} files went with the root tsconfig (${r.tsconfig ?? "none"}). Epoch ${(r.epochMs / 1000).toFixed(2)} s, tool ${(r.toolMs / 1000).toFixed(2)} s (one run each, not a benchmark).`,
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
