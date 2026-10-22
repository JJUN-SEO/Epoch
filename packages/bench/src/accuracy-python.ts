/**
 * pnpm bench:accuracy-python <repo> --python <interpreter> [--src <dir>] [--package <name>] [--out <file>]
 *
 * Measures Python module-edge precision and recall against grimp (M4) on a
 * pinned checkout. grimp runs in a throwaway virtualenv
 * (packages/bench/python/requirements.txt) through grimp_edges.py: it parses
 * the package with Python's ast module, imports none of it, and writes no
 * cache. A benchmark aid only, never part of Epoch (ADR-006).
 */
import childProcess from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { RawImport } from "@epoch-dev/core";
import { analyze } from "@epoch-dev/engine";
import { hostInfo, pct, repoInfo, table, writeReport } from "./report.js";

interface GrimpOutput {
  readonly version: string;
  readonly modules: readonly string[];
  readonly edges: readonly {
    importer: string;
    imported: string;
    lines: number[];
  }[];
}

const HELPER = fileURLToPath(
  new URL("../python/grimp_edges.py", import.meta.url),
);

interface EpochEdge {
  readonly kinds: Set<RawImport["kind"]>;
  readonly lines: Set<number>;
}

interface Disagreement {
  readonly side: "epoch-only" | "tool-only";
  readonly from: string;
  readonly to: string;
  readonly lines: readonly number[];
  /** tool-wrong: a real import grimp misses; unclassified counts against Epoch. */
  readonly verdict: "tool-wrong" | "unclassified";
  readonly reason: string;
}

/** grimp's module finder skips a folder without __init__.py inside a regular package (modulefinder.py: "orphans"). */
const ORPHAN_REASON =
  "a module in a folder without `__init__.py` inside a regular package: Python imports it as a namespace package (PEP 420), grimp's module finder does not descend there";

const key = (a: string, b: string) => `${a}\u0000${b}`;

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
  const [dir] = positionals;
  if (dir === undefined || values.python === undefined) {
    process.stderr.write(
      "usage: pnpm bench:accuracy-python <repo> --python <venv python> [--src src] [--package flask]\n",
    );
    process.exitCode = 1;
    return;
  }
  const repo = repoInfo(dir);
  const pkgDir = `${values.src}/${values.package}`;

  let t = performance.now();
  const tool = JSON.parse(
    childProcess.execFileSync(
      values.python,
      ["-I", HELPER, path.join(repo.root, values.src), values.package],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    ),
  ) as GrimpOutput;
  const toolMs = performance.now() - t;

  /** "src/flask/json/__init__.py" -> "flask.json"; undefined outside the package. */
  const moduleOf = (file: string): string | undefined => {
    if (!file.startsWith(`${pkgDir}/`) || !file.endsWith(".py"))
      return undefined;
    const rel = file.slice(values.src.length + 1, -".py".length).split("/");
    if (rel.at(-1) === "__init__") rel.pop();
    return rel.join(".");
  };

  const epoch = new Map<string, EpochEdge>();
  const modules = new Set<string>();
  t = performance.now();
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
    const orphan = !toolModules.has(from) || !toolModules.has(to);
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
          ? "dynamic import with a literal name (importlib); grimp reads import statements only"
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
  const ratio = (n: number, d: number) => (d === 0 ? 1 : n / d);
  // Raw: grimp is the truth. Adjusted: the reference set is the agreed edges
  // plus the real imports grimp misses (classified above).
  const real = disagreements.filter(
    (d) => d.side === "epoch-only" && d.verdict === "tool-wrong",
  ).length;
  const raw = { p: ratio(both, epoch.size), r: ratio(both, toolEdges.size) };
  const adjusted = {
    p: ratio(both + real, epoch.size),
    r: ratio(both + real, toolEdges.size + real),
  };

  const report = [
    "# Python edge accuracy",
    "",
    "Generated by `pnpm bench:accuracy-python` (packages/bench/src/accuracy-python.ts). Do not edit by hand.",
    "",
    "## Method",
    "",
    `- **Ground truth:** grimp ${tool.version} (\`build_graph\`, cache off), in a throwaway virtualenv from \`packages/bench/python/requirements.txt\`. grimp parses the package with Python's \`ast\` module and imports none of it; it is a benchmark aid, never part of Epoch (ADR-006).`,
    `- **Compared:** module-to-module imports inside the \`${values.package}\` package (\`${pkgDir}\`), \`TYPE_CHECKING\` imports included on both sides (grimp's default).`,
    "- **Epoch's side** is each import's resolution, before barrel tracing, so a `from . import x` that names a function in `__init__.py` counts as an import of the package on both sides.",
    "- **Every disagreement** is listed below with its reason. *Raw* scores treat grimp as the truth; *adjusted* scores use the agreed edges plus the real imports grimp misses (each listed with the rule that shows it is real). Unclassified disagreements count against Epoch.",
    `- **Host:** ${hostInfo()}.`,
    "",
    "## Results",
    "",
    table(
      ["Repository", "Commit", "Modules (grimp)", "Modules (Epoch)", "In both"],
      [
        [
          repo.url ?? repo.name,
          repo.commit?.slice(0, 12) ?? "unknown",
          String(toolModules.size),
          String(modules.size),
          String([...modules].filter((m) => toolModules.has(m)).length),
        ],
      ],
    ),
    "",
    table(
      [
        "Edges",
        "Epoch",
        "grimp",
        "Agreed",
        "Raw precision",
        "Raw recall",
        "Adjusted precision",
        "Adjusted recall",
        "Unclassified",
      ],
      [
        [
          "Module imports",
          String(epoch.size),
          String(toolEdges.size),
          String(both),
          pct(raw.p),
          pct(raw.r),
          pct(adjusted.p),
          pct(adjusted.r),
          String(
            disagreements.filter((d) => d.verdict === "unclassified").length,
          ),
        ],
      ],
    ),
    "",
    `Epoch ${(epochMs / 1000).toFixed(2)} s (no cache, the whole repository), grimp ${(toolMs / 1000).toFixed(2)} s (one run each, not a benchmark).`,
    "",
    "## Disagreements",
    "",
    disagreements.length === 0
      ? "None."
      : table(
          ["Only in", "From", "To", "Lines", "Verdict", "Reason"],
          disagreements.map((d) => [
            d.side,
            d.from,
            d.to,
            d.lines.join(", "),
            d.verdict,
            d.reason,
          ]),
        ),
    "",
    ...(modules.size !== toolModules.size ||
    [...modules].some((m) => !toolModules.has(m))
      ? [
          "Modules only one side has:",
          "",
          table(
            ["Module", "Only in"],
            [
              ...[...modules]
                .filter((m) => !toolModules.has(m))
                .map((m) => [m, "Epoch"]),
              ...[...toolModules]
                .filter((m) => !modules.has(m))
                .map((m) => [m, "grimp"]),
            ],
          ),
          "",
        ]
      : []),
  ].join("\n");
  writeReport(path.resolve(values.out), report);
  process.stdout.write(`${report}\nwrote ${values.out}\n`);
}

await main();
