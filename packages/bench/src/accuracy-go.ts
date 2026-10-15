/**
 * pnpm bench:accuracy-go <repo> [--out <file>]
 *
 * Measures Go package-edge precision and recall against `go list` (M4) on a
 * pinned checkout. `go list` runs offline (GOTOOLCHAIN=local, GOPROXY=off,
 * GOFLAGS=-mod=mod, GOWORK=off): it reads go.mod and source files and loads
 * no project code, and it is a benchmark aid only, never part of Epoch
 * (ADR-006, ADR-013).
 */
import childProcess from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { analyze, toPosix } from "@epoch-dev/engine";
import {
  hostInfo,
  pct,
  repoInfo,
  table,
  writeReport,
  type RepoInfo,
} from "./report.js";

/** The fields read from `go list -json`. */
interface GoPackage {
  readonly ImportPath: string;
  readonly Dir: string;
  readonly Module?: { readonly Path: string; readonly Main?: boolean };
  readonly GoFiles?: readonly string[];
  readonly CgoFiles?: readonly string[];
  readonly IgnoredGoFiles?: readonly string[];
  readonly TestGoFiles?: readonly string[];
  readonly XTestGoFiles?: readonly string[];
  readonly Imports?: readonly string[];
  readonly TestImports?: readonly string[];
  readonly XTestImports?: readonly string[];
}

/** Splits the concatenated JSON objects `go list -json` prints. */
function parseGoList(text: string): GoPackage[] {
  const out: GoPackage[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0)
        out.push(JSON.parse(text.slice(start, i + 1)) as GoPackage);
    }
  }
  return out;
}

function goList(root: string): {
  packages: GoPackage[];
  version: string;
  ms: number;
} {
  const env = {
    ...process.env,
    GOTOOLCHAIN: "local",
    GOPROXY: "off",
    GOFLAGS: "-mod=mod",
    GOWORK: "off",
    GONOSUMDB: "*",
  };
  const version = childProcess
    .execFileSync("go", ["version"], { env, encoding: "utf8" })
    .trim();
  const t = performance.now();
  const result = childProcess.spawnSync(
    "go",
    [
      "list",
      "-e",
      "-json=ImportPath,Dir,Module,GoFiles,CgoFiles,IgnoredGoFiles,TestGoFiles,XTestGoFiles,Imports,TestImports,XTestImports",
      "./...",
    ],
    { cwd: root, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const ms = performance.now() - t;
  if (result.status !== 0 && result.stdout === "") {
    throw new Error(`go list failed: ${result.stderr}`);
  }
  return { packages: parseGoList(result.stdout), version, ms };
}

interface GoDisagreement {
  readonly side: "epoch-only" | "tool-only";
  readonly scope: "production" | "tests";
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  /** The files behind the edge (Epoch side) or "" (tool side). */
  readonly files: readonly string[];
}

interface Result {
  readonly repo: RepoInfo;
  readonly module: string;
  readonly goVersion: string;
  readonly epochMs: number;
  readonly toolMs: number;
  readonly packages: { tool: number; epoch: number; both: number };
  readonly production: { epoch: number; tool: number; both: number };
  readonly tests: { epoch: number; tool: number; both: number };
  readonly disagreements: readonly GoDisagreement[];
}

const key = (a: string, b: string) => `${a}\u0000${b}`;

async function measure(dir: string): Promise<Result> {
  const repo = repoInfo(dir);
  const { packages, version, ms: toolMs } = goList(repo.root);
  const main = packages.filter((p) => p.Module?.Main === true);
  const module = main[0]?.Module?.Path ?? "";
  const byDir = new Map(
    main.map((p) => {
      const rel = toPosix(path.relative(repo.root, p.Dir));
      return [rel === "" ? "" : rel, p] as const;
    }),
  );
  const local = new Set(main.map((p) => p.ImportPath));

  // Epoch: each import's resolution, attributed to the go list package of
  // the importing file's directory.
  const epochFiles = new Map<string, string[]>(); // edge key -> files
  const epochTestFiles = new Map<string, string[]>();
  const t = performance.now();
  const { graph } = await analyze(repo.root, {
    history: false,
    onResolution: (from, _imp, res) => {
      if (!from.endsWith(".go") || res.kind !== "package") return;
      const dirOf = from.includes("/")
        ? from.slice(0, from.lastIndexOf("/"))
        : "";
      const pkg = byDir.get(dirOf);
      if (!pkg) return;
      const target = res.target.slice("pkg:".length);
      const map = from.endsWith("_test.go") ? epochTestFiles : epochFiles;
      const k = key(pkg.ImportPath, target);
      map.set(k, [...(map.get(k) ?? []), from]);
    },
  });
  const epochMs = performance.now() - t;

  const toolProd = new Set<string>();
  const toolTests = new Set<string>();
  for (const p of main) {
    for (const i of p.Imports ?? [])
      if (local.has(i)) toolProd.add(key(p.ImportPath, i));
    for (const i of [...(p.TestImports ?? []), ...(p.XTestImports ?? [])]) {
      if (local.has(i) && i !== p.ImportPath)
        toolTests.add(key(p.ImportPath, i));
    }
  }
  // An external _test package importing its own package is a real import,
  // but every test file is linked to its package anyway; leave it out.
  for (const k of [...epochTestFiles.keys()]) {
    const [from, to] = k.split("\u0000");
    if (from === to) epochTestFiles.delete(k);
  }

  const ignored = new Set(
    main.flatMap((p) => {
      const rel = toPosix(path.relative(repo.root, p.Dir));
      return (p.IgnoredGoFiles ?? []).map((f) =>
        rel === "" ? f : `${rel}/${f}`,
      );
    }),
  );
  const disagreements: GoDisagreement[] = [];
  const compare = (
    scope: GoDisagreement["scope"],
    epoch: Map<string, string[]>,
    tool: Set<string>,
  ) => {
    let both = 0;
    for (const [k, files] of epoch) {
      if (tool.has(k)) {
        both++;
        continue;
      }
      const [from = "", to = ""] = k.split("\u0000");
      disagreements.push({
        side: "epoch-only",
        scope,
        from,
        to,
        files,
        reason: files.every((f) => ignored.has(f))
          ? "only from files the go tool excludes by build constraints here (not evaluated, ADR-013)"
          : "unclassified",
      });
    }
    for (const k of tool) {
      if (epoch.has(k)) continue;
      const [from = "", to = ""] = k.split("\u0000");
      disagreements.push({
        side: "tool-only",
        scope,
        from,
        to,
        files: [],
        reason: "unclassified",
      });
    }
    return { epoch: epoch.size, tool: tool.size, both };
  };
  const production = compare("production", epochFiles, toolProd);
  const tests = compare("tests", epochTestFiles, toolTests);

  const epochPackages = new Set(
    graph.nodes.filter((n) => n.kind === "package").map((n) => n.id.slice(4)),
  );
  const withSource = main.filter(
    (p) =>
      (p.GoFiles?.length ?? 0) +
        (p.CgoFiles?.length ?? 0) +
        (p.IgnoredGoFiles?.length ?? 0) >
      0,
  );
  return {
    repo,
    module,
    goVersion: version,
    epochMs,
    toolMs,
    packages: {
      tool: withSource.length,
      epoch: [...epochPackages].filter(
        (p) => p === module || p.startsWith(`${module}/`),
      ).length,
      both: withSource.filter((p) => epochPackages.has(p.ImportPath)).length,
    },
    production,
    tests,
    disagreements,
  };
}

const score = (s: { epoch: number; tool: number; both: number }) => ({
  precision: s.epoch === 0 ? 1 : s.both / s.epoch,
  recall: s.tool === 0 ? 1 : s.both / s.tool,
});

function render(r: Result): string {
  const prod = score(r.production);
  const tests = score(r.tests);
  const lines = [
    "# Go edge accuracy",
    "",
    "Generated by `pnpm bench:accuracy-go` (packages/bench/src/accuracy-go.ts). Do not edit by hand.",
    "",
    "## Method",
    "",
    `- **Ground truth:** \`go list -e -json ./...\` from ${r.goVersion}, run offline (\`GOTOOLCHAIN=local\`, \`GOPROXY=off\`, \`GOFLAGS=-mod=mod\`, \`GOWORK=off\`) on a pinned clone. It reads go.mod and the source files and loads no project code; it is a benchmark aid, never part of Epoch (ADR-006).`,
    "- **Compared:** package-to-package imports inside the main module. *Production* uses each package's `Imports`; *tests* uses `TestImports` and `XTestImports` (an external test package's import of its own package is left out on both sides).",
    "- **Epoch's side** is each import's resolution (before the graph folds files into packages), attributed to the package of the importing file's directory, so the two sides count the same thing.",
    "- **Build constraints:** `go list` evaluates them for this host's GOOS and GOARCH; Epoch does not (ADR-013). An Epoch-only edge that comes only from files `go list` reports as excluded (`IgnoredGoFiles`) is classified as such.",
    `- **Host:** ${hostInfo()}.`,
    "",
    "## Results",
    "",
    table(
      [
        "Repository",
        "Commit",
        "Module",
        "Packages (go list)",
        "Packages (Epoch)",
        "In both",
      ],
      [
        [
          r.repo.url ?? r.repo.name,
          r.repo.commit?.slice(0, 12) ?? "unknown",
          r.module,
          String(r.packages.tool),
          String(r.packages.epoch),
          String(r.packages.both),
        ],
      ],
    ),
    "",
    table(
      ["Edges", "Epoch", "go list", "Agreed", "Precision", "Recall"],
      [
        [
          "Production",
          String(r.production.epoch),
          String(r.production.tool),
          String(r.production.both),
          pct(prod.precision),
          pct(prod.recall),
        ],
        [
          "Tests",
          String(r.tests.epoch),
          String(r.tests.tool),
          String(r.tests.both),
          pct(tests.precision),
          pct(tests.recall),
        ],
      ],
    ),
    "",
    `Epoch ${(r.epochMs / 1000).toFixed(2)} s (no cache), go list ${(r.toolMs / 1000).toFixed(2)} s (one run each, not a benchmark).`,
    "",
    "## Disagreements",
    "",
    r.disagreements.length === 0
      ? "None."
      : table(
          ["Only in", "Scope", "From", "To", "Reason", "Files"],
          r.disagreements.map((d) => [
            d.side,
            d.scope,
            d.from,
            d.to,
            d.reason,
            d.files.join(", "),
          ]),
        ),
    "",
  ];
  return lines.join("\n");
}

async function mainEntry(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { out: { type: "string", default: "docs/benchmarks/go.md" } },
    allowPositionals: true,
  });
  const [dir] = positionals;
  if (dir === undefined) {
    process.stderr.write(
      "usage: pnpm bench:accuracy-go <repo> [--out <file>]\n",
    );
    process.exitCode = 1;
    return;
  }
  const result = await measure(dir);
  writeReport(path.resolve(values.out), render(result));
  process.stdout.write(`${render(result)}\nwrote ${values.out}\n`);
}

await mainEntry();
