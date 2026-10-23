/**
 * pnpm bench:accuracy-python <repo>[:<src>:<package>]... --python <interpreter> [--out <file>]
 *
 * Measures Python module-edge precision and recall (M4) on pinned checkouts,
 * against two references run by the same interpreter:
 *
 * - grimp (packages/bench/python/requirements.txt, in a throwaway virtualenv)
 *   through grimp_edges.py: it parses the package with Python's ast module,
 *   imports none of it, and writes no cache.
 * - CPython's own finders through pathfinder_edges.py: the same ast scan,
 *   with each module name resolved by the path-entry finders Python's import
 *   system uses, so namespace packages (PEP 420) resolve as Python resolves
 *   them. It imports nothing either.
 *
 * Benchmark aids only, never part of Epoch (ADR-006).
 */
import childProcess from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { RawImport } from "@epoch-dev/core";
import { analyze } from "@epoch-dev/engine";
import {
  hostInfo,
  pct,
  repoInfo,
  table,
  writeReport,
  type RepoInfo,
} from "./report.js";

interface ToolOutput {
  readonly version: string;
  readonly modules: readonly string[];
  readonly edges: readonly {
    importer: string;
    imported: string;
    lines: number[];
  }[];
}

const REFERENCES = [
  {
    id: "grimp",
    label: "grimp",
    helper: fileURLToPath(new URL("../python/grimp_edges.py", import.meta.url)),
    // grimp's module finder skips a folder without __init__.py inside a regular package (modulefinder.py: "orphans").
    skipsNamespaceFolders: true,
  },
  {
    id: "finders",
    label: "CPython's finders",
    helper: fileURLToPath(
      new URL("../python/pathfinder_edges.py", import.meta.url),
    ),
    skipsNamespaceFolders: false,
  },
] as const;

interface EpochEdge {
  readonly kinds: Set<RawImport["kind"]>;
  readonly lines: Set<number>;
}

interface Disagreement {
  readonly side: "epoch-only" | "tool-only";
  readonly from: string;
  readonly to: string;
  readonly lines: readonly number[];
  /** tool-wrong: a real import the reference misses; unclassified counts against Epoch. */
  readonly verdict: "tool-wrong" | "unclassified";
  readonly reason: string;
}

interface Comparison {
  readonly reference: (typeof REFERENCES)[number];
  readonly version: string;
  readonly modules: ReadonlySet<string>;
  readonly toolEdges: number;
  readonly both: number;
  readonly disagreements: readonly Disagreement[];
  readonly ms: number;
}

interface RepoResult {
  readonly repo: RepoInfo;
  readonly name: string;
  readonly pkgDir: string;
  readonly modules: ReadonlySet<string>;
  readonly epochEdges: number;
  readonly epochMs: number;
  readonly comparisons: readonly Comparison[];
}

const ORPHAN_REASON =
  "a module in a folder without `__init__.py` inside a regular package: Python imports it as a namespace package (PEP 420), grimp's module finder does not descend there";

const key = (a: string, b: string) => `${a}\u0000${b}`;

async function measure(
  dir: string,
  src: string,
  pkg: string,
  python: string,
): Promise<RepoResult> {
  const repo = repoInfo(dir);
  const pkgDir = src === "." ? pkg : `${src}/${pkg}`;

  /** "src/flask/json/__init__.py" -> "flask.json"; undefined outside the package. */
  const moduleOf = (file: string): string | undefined => {
    if (!file.startsWith(`${pkgDir}/`) || !file.endsWith(".py"))
      return undefined;
    const rel = (src === "." ? file : file.slice(src.length + 1))
      .slice(0, -".py".length)
      .split("/");
    if (rel.at(-1) === "__init__") rel.pop();
    return rel.join(".");
  };

  const epoch = new Map<string, EpochEdge>();
  const modules = new Set<string>();
  let t = performance.now();
  const { graph } = await analyze(repo.root, {
    history: false,
    onResolution: (from, imp, res) => {
      const importer = moduleOf(from);
      if (importer === undefined || res.kind !== "file") return;
      const imported = moduleOf(res.target);
      if (imported === undefined || imported === importer) return;
      const k = key(importer, imported);
      const e = epoch.get(k) ?? { kinds: new Set(), lines: new Set() };
      e.kinds.add(imp.kind);
      e.lines.add(imp.line);
      epoch.set(k, e);
    },
  });
  const epochMs = performance.now() - t;
  for (const n of graph.nodes) {
    const m = moduleOf(n.id);
    if (m !== undefined) modules.add(m);
  }

  const comparisons: Comparison[] = [];
  for (const reference of REFERENCES) {
    t = performance.now();
    const tool = JSON.parse(
      childProcess.execFileSync(
        python,
        ["-I", reference.helper, path.join(repo.root, src), pkg],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      ),
    ) as ToolOutput;
    const ms = performance.now() - t;
    const toolEdges = new Map(
      tool.edges.map((e) => [key(e.importer, e.imported), e.lines] as const),
    );
    const toolModules = new Set(tool.modules);
    const disagreements: Disagreement[] = [];
    let both = 0;
    for (const [k, e] of epoch) {
      if (toolEdges.has(k)) {
        both++;
        continue;
      }
      const [from = "", to = ""] = k.split("\u0000");
      const orphan =
        reference.skipsNamespaceFolders &&
        (!toolModules.has(from) || !toolModules.has(to));
      const dynamic = [...e.kinds].every((kind) => kind === "dynamic");
      disagreements.push({
        side: "epoch-only",
        from,
        to,
        lines: [...e.lines].sort((a, b) => a - b),
        verdict: orphan || dynamic ? "tool-wrong" : "unclassified",
        reason: orphan
          ? ORPHAN_REASON
          : dynamic
            ? "dynamic import with a literal name (importlib); the reference reads import statements only"
            : "unclassified",
      });
    }
    for (const [k, lines] of toolEdges) {
      if (epoch.has(k)) continue;
      const [from = "", to = ""] = k.split("\u0000");
      disagreements.push({
        side: "tool-only",
        from,
        to,
        lines,
        verdict: "unclassified",
        reason: "unclassified",
      });
    }
    comparisons.push({
      reference,
      version: tool.version,
      modules: toolModules,
      toolEdges: toolEdges.size,
      both,
      disagreements,
      ms,
    });
  }
  return {
    repo,
    name: pkg,
    pkgDir,
    modules,
    epochEdges: epoch.size,
    epochMs,
    comparisons,
  };
}

const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);

/** Raw: the reference is the truth. Adjusted: agreed edges plus the real imports it misses. */
function scoresOf(r: RepoResult, c: Comparison) {
  const real = c.disagreements.filter(
    (d) => d.side === "epoch-only" && d.verdict === "tool-wrong",
  ).length;
  return {
    raw: { p: ratio(c.both, r.epochEdges), r: ratio(c.both, c.toolEdges) },
    adjusted: {
      p: ratio(c.both + real, r.epochEdges),
      r: ratio(c.both + real, c.toolEdges + real),
    },
  };
}

const rowName = (r: RepoResult, c: Comparison) =>
  `${r.name} vs ${c.reference.label}`;

function render(results: readonly RepoResult[]): string {
  const versions = [
    ...new Set(
      results.flatMap((r) =>
        r.comparisons.map((c) => `${c.reference.label}: ${c.version}`),
      ),
    ),
  ].join("; ");
  const lines = [
    "# Python edge accuracy",
    "",
    "Generated by `pnpm bench:accuracy-python` (packages/bench/src/accuracy-python.ts). Do not edit by hand.",
    "",
    "## Method",
    "",
    "- **Two references**, run by the same interpreter, both benchmark aids and never part of Epoch (ADR-006):",
    "  - **grimp** (`build_graph`, cache off), in a throwaway virtualenv from `packages/bench/python/requirements.txt`. It parses the package with Python's `ast` module and imports none of it.",
    "  - **CPython's finders** (`packages/bench/python/pathfinder_edges.py`): the same `ast` scan of import statements, with each module name resolved by the path-entry finders Python's import system uses (`sys.path_hooks`), combining namespace portions as `PathFinder` does (PEP 420). It walks each parent's search locations itself, so it imports nothing.",
    `- **Versions:** ${versions}.`,
    "- **Compared:** module-to-module imports inside each package, `TYPE_CHECKING` imports included on all sides (grimp's default).",
    "- **Epoch's side** is each import's resolution, before barrel tracing, so a `from . import x` that names a function in `__init__.py` counts as an import of the package on every side.",
    "- **Every disagreement** is listed below with its reason. *Raw* scores treat the reference as the truth; *adjusted* scores use the agreed edges plus the real imports it misses (each listed with the rule that shows it is real). Unclassified disagreements count against Epoch.",
    `- **Host:** ${hostInfo()}.`,
    "",
    "## Results",
    "",
    table(
      ["Repository", "Commit", "Package", "Modules (Epoch)"],
      results.map((r) => [
        r.repo.url ?? r.repo.name,
        r.repo.commit?.slice(0, 12) ?? "unknown",
        `\`${r.pkgDir}\``,
        String(r.modules.size),
      ]),
    ),
    "",
    table(
      [
        "Edges",
        "Epoch",
        "Reference",
        "Agreed",
        "Raw precision",
        "Raw recall",
        "Adjusted precision",
        "Adjusted recall",
        "Unclassified",
      ],
      results.flatMap((r) =>
        r.comparisons.map((c) => {
          const s = scoresOf(r, c);
          return [
            rowName(r, c),
            String(r.epochEdges),
            String(c.toolEdges),
            String(c.both),
            pct(s.raw.p),
            pct(s.raw.r),
            pct(s.adjusted.p),
            pct(s.adjusted.r),
            String(
              c.disagreements.filter((d) => d.verdict === "unclassified")
                .length,
            ),
          ];
        }),
      ),
    ),
    "",
  ];
  for (const r of results) {
    lines.push(
      `## ${r.name}`,
      "",
      `Commit \`${r.repo.commit ?? "unknown"}\`. Epoch ${(r.epochMs / 1000).toFixed(2)} s (no cache, the whole repository); ${r.comparisons.map((c) => `${c.reference.label} ${(c.ms / 1000).toFixed(2)} s`).join(", ")} (one run each, not a benchmark).`,
      "",
    );
    for (const c of r.comparisons) {
      lines.push(
        `### Against ${c.reference.label}`,
        "",
        c.disagreements.length === 0
          ? "No disagreements."
          : table(
              ["Only in", "From", "To", "Lines", "Verdict", "Reason"],
              c.disagreements.map((d) => [
                d.side,
                d.from,
                d.to,
                d.lines.join(", "),
                d.verdict,
                d.reason,
              ]),
            ),
        "",
      );
      const onlyEpoch = [...r.modules].filter((m) => !c.modules.has(m));
      const onlyTool = [...c.modules].filter((m) => !r.modules.has(m));
      if (onlyEpoch.length + onlyTool.length > 0) {
        lines.push(
          "Modules only one side has:",
          "",
          table(
            ["Module", "Only in"],
            [
              ...onlyEpoch.map((m) => [m, "Epoch"]),
              ...onlyTool.map((m) => [m, c.reference.label]),
            ],
          ),
          "",
        );
      }
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      python: { type: "string" },
      src: { type: "string", default: "src" },
      package: { type: "string", default: "flask" },
      out: { type: "string", default: "docs/benchmarks/python-accuracy.md" },
    },
    allowPositionals: true,
  });
  if (positionals.length === 0 || values.python === undefined) {
    process.stderr.write(
      "usage: pnpm bench:accuracy-python <repo>[:<src>:<package>]... --python <venv python> [--src src] [--package flask]\n",
    );
    process.exitCode = 1;
    return;
  }
  const results: RepoResult[] = [];
  for (const arg of positionals) {
    const [dir = "", src = values.src, pkg = values.package] = arg.split(":");
    process.stderr.write(`measuring ${dir} (${src}/${pkg})...\n`);
    results.push(await measure(dir, src, pkg, values.python));
  }
  const report = render(results);
  writeReport(path.resolve(values.out), report);
  for (const r of results)
    for (const c of r.comparisons) {
      const s = scoresOf(r, c);
      process.stderr.write(
        `${rowName(r, c)}: agreed ${String(c.both)}, raw P ${pct(s.raw.p)} R ${pct(s.raw.r)}, adjusted P ${pct(s.adjusted.p)} R ${pct(s.adjusted.r)}\n`,
      );
    }
  process.stderr.write(`wrote ${values.out}\n`);
}

await main();
