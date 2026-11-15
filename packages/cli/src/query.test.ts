import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AnalysisMeta, Finding, Graph, GraphNode } from "@epoch-dev/core";
import { exportGraph } from "./export-graph.js";
import {
  formatExplain,
  formatImpact,
  formatImpactMarkdown,
  formatPath,
} from "./format-query.js";
import {
  explain,
  findNodes,
  findingsList,
  impact,
  impactFails,
  overview,
  pathBetween,
  resolveNode,
  riskList,
  type Snapshot,
} from "./query.js";
import { EXIT_ERROR, EXIT_IMPACT, EXIT_OK, run } from "./run.js";

// The command tests run whole analyses: slow on a loaded Windows runner.
vi.setConfig({ testTimeout: 60_000 });

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-query-"));
process.env.EPOCH_CACHE_DIR = cacheDir;
afterAll(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, {
    stdout: { write: (s: string) => (stdout += s) },
    stderr: { write: (s: string) => (stderr += s) },
  });
  return { code, stdout, stderr };
}

const node = (id: string, metrics: Partial<GraphNode["metrics"]> = {}) =>
  ({
    id,
    kind: id.startsWith("pkg:") ? "package" : "file",
    language: id.startsWith("pkg:") || id.endsWith(".go") ? "go" : "typescript",
    loc: 40,
    contentHash: id,
    exports: [],
    externals: id === "src/a.ts" ? ["zod"] : [],
    flags: [],
    metrics: { fanIn: 0, fanOut: 0, ...metrics },
  }) satisfies GraphNode;

const edge = (
  source: string,
  target: string,
  kind: Graph["edges"][number]["kind"] = "import",
  confidence = 1,
): Graph["edges"][number] => ({
  source,
  target,
  kind,
  provenance: confidence < 1 ? "git-cochange" : "resolver",
  confidence,
  evidence: confidence < 1 ? ["changed together in 9 of 10 commits"] : [],
});

const finding = (
  id: string,
  file: string,
  confidence: Finding["confidence"],
): Finding => ({
  id,
  kind: "dead-branch",
  subject: { type: "file", name: file },
  confidence,
  locations: [{ file, line: 7 }],
  evidence: ["`if (false)` at line 7"],
  caveats: ["a build may replace the constant"],
  suggestedAction: "Remove the branch that can never run",
  caps: [],
});

/** a -> b -> core; ui/index.ts -> core; a test file beside a Go package. */
const snapshot: Snapshot = {
  graph: {
    schemaVersion: 2,
    nodes: [
      node("pkg:m/db"),
      node("src/a.ts", {
        dependents: 0,
        churn90d: 1,
        risk: { tier: "low", archetype: "stable-leaf" },
      }),
      node("src/b.ts", {
        dependents: 1,
        churn90d: 4,
        coverage: 0.25,
        risk: { tier: "moderate", archetype: "fragile-leaf" },
      }),
      node("src/core.ts", {
        fanIn: 2,
        dependents: 9,
        churn90d: 5,
        risk: { tier: "critical", archetype: "volatile-core" },
      }),
      node("src/index.ts"),
      node("ui/index.ts", { dependents: 0 }),
    ],
    edges: [
      edge("src/a.ts", "src/b.ts"),
      edge("src/b.ts", "src/core.ts", "type-only"),
      edge("ui/index.ts", "src/core.ts"),
      edge("src/a.ts", "ui/index.ts", "cochange", 0.9),
      edge("src/index.ts", "src/a.ts", "cochange", 0.2),
    ],
    roots: [
      { file: "src/a.ts", reason: "manifest", source: "package.json main" },
    ],
    findings: [
      finding("f-high", "src/core.ts", "high"),
      finding("f-low", "src/core.ts", "low"),
      finding("f-gone", "src/b.ts", "high"),
      finding("f-go", "db/conn.go", "medium"),
    ],
    unresolved: [
      {
        from: "src/a.ts",
        specifier: null,
        reason: "dynamic-specifier",
        line: 3,
      },
    ],
  },
  meta: {
    epochVersion: "9.9.9",
    counts: { filesAnalyzed: 7 },
    cycles: [],
    git: { status: "usable" },
    coverage: { reports: [{ source: "coverage/lcov.info" }] },
    findings: { minConfidence: "medium" },
  } as unknown as AnalysisMeta,
  packages: new Map([["pkg:m/db", ["db/conn.go", "db/pool.go"]]]),
  dismissed: new Set(["f-gone"]),
};

describe("resolveNode and findNodes", () => {
  it("takes an id, a package member, or a unique ending", () => {
    expect(resolveNode(snapshot, "src/core.ts")).toEqual({ id: "src/core.ts" });
    expect(resolveNode(snapshot, ".\\src\\core.ts")).toEqual({
      id: "src/core.ts",
    });
    expect(resolveNode(snapshot, "db/pool.go")).toEqual({ id: "pkg:m/db" });
    expect(resolveNode(snapshot, "core.ts")).toEqual({ id: "src/core.ts" });
    expect(resolveNode(snapshot, "conn.go")).toEqual({ id: "pkg:m/db" });
  });

  it("refuses a name that fits several files, and one that fits none", () => {
    expect(resolveNode(snapshot, "index.ts")).toEqual({
      error: "index.ts matches 2 files; name one of them.",
      candidates: ["src/index.ts", "ui/index.ts"],
    });
    expect(resolveNode(snapshot, "nope.ts")).toEqual({
      error: "No analyzed file matches nope.ts.",
      candidates: [],
    });
  });

  it("finds by any part of the path, closest first, and says how many", () => {
    expect(findNodes(snapshot, "INDEX", 10)).toEqual({
      matches: ["src/index.ts", "ui/index.ts"],
      total: 2,
    });
    expect(findNodes(snapshot, "src", 2)).toEqual({
      matches: ["src/a.ts", "src/b.ts"],
      total: 4,
    });
    expect(findNodes(snapshot, "pool", 10).matches).toEqual(["pkg:m/db"]);
    expect(findNodes(snapshot, "", 10).total).toBe(0);
  });
});

describe("explain", () => {
  it("gives a node's facts, neighbors, hints and open candidates", () => {
    const r = explain(snapshot, "src/core.ts");
    expect(r).toMatchObject({
      id: "src/core.ts",
      language: "typescript",
      languageTier: "A",
      lines: 40,
      dependents: 9,
      commits90d: 5,
      risk: {
        tier: "critical",
        archetype: "volatile-core",
        exposure: "exposed",
        change: "hot",
        fragility: "sturdy",
      },
      imports: [],
      importedBy: [
        { id: "src/b.ts", kind: "type-only" },
        { id: "ui/index.ts", kind: "import" },
      ],
    });
    expect(r.findings.map((f) => f.id)).toEqual(["f-high", "f-low"]);
    expect(r.coverage).toBeUndefined();
  });

  it("lists hints above the threshold apart from facts, and never a dismissed candidate", () => {
    const a = explain(snapshot, "src/a.ts");
    expect(a.imports).toEqual([
      { id: "src/b.ts", kind: "import", evidence: [] },
    ]);
    // The 0.2 hint from src/index.ts is below the default threshold.
    expect(a.likely).toEqual([
      {
        id: "ui/index.ts",
        kind: "cochange",
        evidence: ["changed together in 9 of 10 commits"],
        direction: "out",
        confidence: 0.9,
      },
    ]);
    expect(a.entryPoint).toEqual(["manifest: package.json main"]);
    expect(a.externals).toEqual(["zod"]);
    expect(a.unresolved).toHaveLength(1);
    expect(explain(snapshot, "src/b.ts").findings).toEqual([]);
  });

  it("explains a package through its member files", () => {
    const r = explain(snapshot, "pkg:m/db");
    expect(r.members).toEqual(["db/conn.go", "db/pool.go"]);
    expect(r.findings.map((f) => f.id)).toEqual(["f-go"]);
    expect(r.risk).toBeUndefined();
  });

  it("prints a report with the facts named, and hedged candidates", () => {
    const text = formatExplain(explain(snapshot, "src/core.ts"));
    expect(text).toContain("src/core.ts\n  language     typescript, tier A\n");
    expect(text).toContain(
      "  risk         critical (volatile-core): exposed, hot, sturdy\n",
    );
    expect(text).toContain("  imported by (2):\n    src/b.ts  type-only\n");
    expect(text).toContain(
      "[Worth a look] Branch that likely never runs: src/core.ts:7",
    );
    expect(text).toContain("never verdicts");
    expect(text).not.toMatch(/\bdead\b/i);
    expect(formatExplain(explain(snapshot, "src/b.ts"))).toContain(
      "  coverage     25% of its lines run in tests\n",
    );
  });
});

describe("pathBetween", () => {
  it("finds the chain, or the reverse one, or neither", () => {
    const forward = pathBetween(snapshot, "src/a.ts", "src/core.ts", false);
    expect(forward.path?.nodes).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/core.ts",
    ]);
    expect(forward.reverse).toBeNull();
    expect(formatPath(forward, false)).toBe(
      [
        "src/a.ts depends on src/core.ts (2 hops):",
        "  src/a.ts -> src/b.ts  import",
        "  src/b.ts -> src/core.ts  type-only",
        "",
      ].join("\n"),
    );

    const back = pathBetween(snapshot, "src/core.ts", "src/a.ts", false);
    expect(back.path).toBeNull();
    expect(back.reverse?.nodes).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/core.ts",
    ]);
    expect(formatPath(back, false)).toContain(
      "src/core.ts does not depend on src/a.ts.\nsrc/a.ts depends on src/core.ts (2 hops):",
    );

    const none = pathBetween(snapshot, "src/a.ts", "ui/index.ts", false);
    expect(formatPath(none, false)).toBe(
      "src/a.ts does not depend on ui/index.ts.\nNeither depends on the other through proven imports (add --likely to follow hints).\n",
    );
  });

  it("says when a hop is a hint", () => {
    const r = pathBetween(snapshot, "src/a.ts", "ui/index.ts", true);
    expect(formatPath(r, true)).toBe(
      [
        "src/a.ts depends on ui/index.ts (1 hop; 1 hop is a likely relation, not a proven import):",
        "  src/a.ts -> ui/index.ts  likely cochange (0.90), a hint; changed together in 9 of 10 commits",
        "",
      ].join("\n"),
    );
  });
});

describe("impact", () => {
  it("reports changed nodes by risk, what they reach, and open candidates", () => {
    const r = impact(
      snapshot,
      ["src/core.ts", "db/conn.go", "README.md"],
      false,
    );
    expect(r.changed.map((c) => c.id)).toEqual(["src/core.ts", "pkg:m/db"]);
    expect(r.unanalyzed).toEqual(["README.md"]);
    expect(r.affected.map((a) => a.id)).toEqual([
      "src/b.ts",
      "ui/index.ts",
      "src/a.ts",
    ]);
    expect(r.highestTier).toBe("critical");
    expect(r.candidates.map((f) => f.id)).toEqual(["f-high", "f-low", "f-go"]);
    expect(impactFails(r, "high")).toBe(true);
    expect(impactFails(r, "critical")).toBe(true);
    expect(impactFails(impact(snapshot, ["src/b.ts"], false), "high")).toBe(
      false,
    );
    expect(impactFails(impact(snapshot, ["README.md"], false), "low")).toBe(
      false,
    );
  });

  it("prints text and Markdown with counts, never calling a candidate dead", () => {
    const r = impact(
      snapshot,
      ["src/core.ts", "db/conn.go", "README.md"],
      false,
    );
    const text = formatImpact(r);
    expect(text).toContain(
      "Change impact: 2 changed files analyzed; 3 files affected, up to 2 imports away\n",
    );
    expect(text).toContain(
      "  critical      src/core.ts  (9 dependents; 2 candidates)\n",
    );
    expect(text).toContain(
      "  no tier       pkg:m/db  (1 candidate; changed: db/conn.go)\n",
    );
    expect(text).toContain("Not analyzed (not in the graph): README.md\n");
    expect(text).toContain("Affected, by folder:\n      2  src\n      1  ui\n");
    expect(text).toContain("never verdicts");

    const md = formatImpactMarkdown(r);
    expect(md).toContain("### Epoch change impact");
    expect(md).toContain("Riskiest change: **critical**.");
    expect(md).toContain("| src/core.ts | critical | 9 | 2 |");
    expect(md).toContain("| pkg:m/db | no tier |  | 1 |");
    expect(`${text}${md}`).not.toMatch(/\bdead\b/i);
  });

  it("escapes repository strings in Markdown", () => {
    const hostile: Snapshot = {
      ...snapshot,
      graph: {
        ...snapshot.graph,
        nodes: [...snapshot.graph.nodes, node("src/[x](http://e.vil)|<b>.ts")],
      },
    };
    const md = formatImpactMarkdown(
      impact(hostile, ["src/[x](http://e.vil)|<b>.ts"], false),
    );
    expect(md).toContain("src/\\[x\\](http://e.vil)\\|\\<b\\>.ts");
  });

  it("says when nothing depends on the change", () => {
    expect(formatImpact(impact(snapshot, ["src/a.ts"], false))).toContain(
      "1 changed file analyzed; nothing else depends on them",
    );
  });
});

describe("overview, riskList and findingsList", () => {
  it("summarizes the project", () => {
    expect(overview(snapshot)).toMatchObject({
      epochVersion: "9.9.9",
      files: 7,
      nodes: 6,
      factEdges: 3,
      likelyRelations: 2,
      languages: [
        { language: "typescript", nodes: 5, tier: "A" },
        { language: "go", nodes: 1, tier: "A" },
      ],
      unresolved: { "dynamic-specifier": 1 },
      git: "usable",
      coverageReports: ["coverage/lcov.info"],
      riskTiers: {
        critical: 1,
        high: 0,
        moderate: 1,
        "low-moderate": 0,
        low: 1,
      },
      candidates: { high: 1, medium: 1, low: 1 },
      mostDependedOn: [
        { id: "src/core.ts", dependents: 9 },
        { id: "src/b.ts", dependents: 1 },
      ],
      riskiest: [
        { id: "src/core.ts", tier: "critical" },
        { id: "src/b.ts", tier: "moderate" },
        { id: "src/a.ts", tier: "low" },
      ],
    });
  });

  it("lists nodes by risk, with a cap and the total", () => {
    const all = riskList(snapshot, {}, 2);
    expect(all.nodes.map((n) => n.id)).toEqual(["src/core.ts", "src/b.ts"]);
    expect(all.total).toBe(3);
    expect(all.nodes[1]).toMatchObject({ coverage: 0.25, commits90d: 4 });
    expect(riskList(snapshot, { tier: "low" }, 5).nodes).toHaveLength(1);
    const noGit: Snapshot = {
      ...snapshot,
      graph: {
        ...snapshot.graph,
        nodes: snapshot.graph.nodes.map((n) => node(n.id)),
      },
      meta: { ...snapshot.meta, git: { status: "not-a-repo" } },
    };
    expect(riskList(noGit, {}, 5)).toEqual({
      nodes: [],
      total: 0,
      unavailable: "No risk tiers: they need git history (not-a-repo).",
    });
  });

  it("lists open candidates at the project's level, most confident first", () => {
    const d = findingsList(snapshot, {}, 10);
    expect(d.minConfidence).toBe("medium");
    expect(d.findings.map((f) => f.id)).toEqual(["f-high", "f-go"]);
    expect(
      findingsList(snapshot, { minConfidence: "low" }, 10).findings.map(
        (f) => f.id,
      ),
    ).toEqual(["f-high", "f-go", "f-low"]);
    expect(
      findingsList(snapshot, { node: "pkg:m/db" }, 10).findings.map(
        (f) => f.id,
      ),
    ).toEqual(["f-go"]);
    expect(findingsList(snapshot, { minConfidence: "low" }, 1)).toMatchObject({
      total: 3,
    });
  });
});

describe("exportGraph", () => {
  const g: Graph = {
    ...snapshot.graph,
    nodes: [...snapshot.graph.nodes, node('odd/"a"&<b>.ts')],
    edges: [...snapshot.graph.edges, edge('odd/"a"&<b>.ts', "src/core.ts")],
  };

  it("writes GraphML with escaped ids and node facts", () => {
    const xml = exportGraph(g, "graphml");
    expect(xml).toContain(
      '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    );
    expect(xml).toContain(
      '<node id="src/core.ts"><data key="kind">file</data><data key="language">typescript</data><data key="lines">40</data><data key="dependents">9</data><data key="risk">critical</data></node>',
    );
    expect(xml).toContain('<node id="odd/&quot;a&quot;&amp;&lt;b&gt;.ts">');
    expect(xml).toContain(
      '<edge source="src/b.ts" target="src/core.ts"><data key="edgeKind">type-only</data><data key="confidence">1</data></edge>',
    );
    // Hints are left out unless asked for.
    expect(xml).not.toContain("cochange");
    expect(exportGraph(g, "graphml", { likely: true })).toContain(
      '<edge source="src/a.ts" target="ui/index.ts"><data key="edgeKind">cochange</data><data key="confidence">0.9</data></edge>',
    );
  });

  it("writes DOT and Mermaid with every repository string quoted", () => {
    const dot = exportGraph(g, "dot", { likely: true });
    expect(dot.startsWith("digraph epoch {\n")).toBe(true);
    expect(dot).toContain('  "odd/\\"a\\"&<b>.ts" -> "src/core.ts";');
    expect(dot).toContain('  "src/b.ts" -> "src/core.ts" [label="type-only"];');
    expect(dot).toContain(
      '  "src/a.ts" -> "ui/index.ts" [style=dashed, label="cochange 0.90"];',
    );

    const mermaid = exportGraph(g, "mermaid");
    expect(mermaid.startsWith("flowchart LR\n")).toBe(true);
    expect(mermaid).toContain('["odd/#quot;a#quot;#amp;#lt;b#gt;.ts"]');
    expect(mermaid).toMatch(/ {2}n\d+ --> n\d+\n/);
    expect(mermaid).toMatch(/ {2}n\d+ -- "type-only" --> n\d+\n/);
  });

  it("keeps only one folder's files and the edges among them with a scope", () => {
    const dot = exportGraph(g, "dot", { scope: "src" });
    expect(dot).toContain('"src/a.ts" -> "src/b.ts";');
    expect(dot).not.toContain("ui/index.ts");
    expect(dot).not.toContain("odd/");
  });
});

describe("the commands", () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: dir, stdio: "pipe" },
    );

  beforeAll(() => {
    dir = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cli-impact-")),
    );
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    write("src/core.ts", "export const c = 1;\n");
    write("src/a.ts", 'import { c } from "./core";\nexport const a = c;\n');
    write("src/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
    // An entry point that reaches every src file, so none is a candidate.
    write("package.json", '{ "name": "fixture", "main": "src/index.ts" }\n');
    write("src/index.ts", 'import { b } from "./b";\nexport const i = b;\n');
    write("lib/index.ts", "export const l = 1;\n");
    write("README.md", "# one\n");
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "one");
    write("src/core.ts", "export const c = 2;\n");
    write("README.md", "# two\n");
    git("add", "-A");
    git("commit", "-q", "-m", "two");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("impact --base: what a commit range touches, and exit 2 at --fail-on", async () => {
    const r = await cli("impact", dir, "--base", "HEAD~1");
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain(
      "Change impact: 1 changed file analyzed; 3 files affected, up to 3 imports away\n",
    );
    expect(r.stdout).toContain("  low           src/core.ts  (3 dependents)\n");
    expect(r.stdout).toContain("Not analyzed (not in the graph): README.md\n");
    expect(r.stdout).toContain("Affected, by folder:\n      3  src\n");

    expect(
      (await cli("impact", dir, "--base", "HEAD~1", "--fail-on", "low")).code,
    ).toBe(EXIT_IMPACT);
    expect(
      (await cli("impact", dir, "--base", "HEAD~1", "--fail-on", "high")).code,
    ).toBe(EXIT_OK);
  });

  it("impact --files: several names, as JSON or Markdown", async () => {
    const json = await cli(
      "impact",
      dir,
      "--files",
      "src/a.ts",
      "src/b.ts",
      "--json",
    );
    expect(json.code).toBe(EXIT_OK);
    const report = JSON.parse(json.stdout) as {
      changed: { id: string }[];
      total: number;
    };
    expect(report.changed.map((c) => c.id)).toEqual(["src/a.ts", "src/b.ts"]);
    // src/index.ts imports b.
    expect(report.total).toBe(1);

    const md = await cli(
      "impact",
      dir,
      "--files",
      path.join(dir, "src", "core.ts"),
      "--markdown",
    );
    expect(md.stdout).toContain("### Epoch change impact");
    expect(md.stdout).toContain("| src/core.ts | low | 3 | 0 |");
  });

  it("impact refuses a missing or doubled selection, a bad tier and an unknown commit", async () => {
    for (const args of [
      ["impact", dir],
      ["impact", dir, "--base", "HEAD", "--files", "src/a.ts"],
      ["impact", dir, "--files", "src/a.ts", "--fail-on", "scary"],
      ["impact", dir, "--files", "src/a.ts", "--json", "--markdown"],
    ]) {
      const r = await cli(...args);
      expect(r.code).toBe(EXIT_ERROR);
      expect(r.stderr).toContain("Usage:");
    }
    const unknown = await cli("impact", dir, "--base", "no-such-ref");
    expect(unknown.code).toBe(EXIT_ERROR);
    expect(unknown.stderr).toContain("unknown commit");
  });

  it("path: the chain, by any unambiguous name", async () => {
    const r = await cli("path", dir, "b.ts", "core.ts");
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toBe(
      [
        "src/b.ts depends on src/core.ts (2 hops):",
        "  src/b.ts -> src/a.ts  import",
        "  src/a.ts -> src/core.ts  import",
        "",
      ].join("\n"),
    );
    const json = await cli("path", dir, "src/core.ts", "src/b.ts", "--json");
    const report = JSON.parse(json.stdout) as {
      path: unknown;
      reverse: { nodes: string[] };
    };
    expect(report.path).toBeNull();
    expect(report.reverse.nodes).toEqual([
      "src/b.ts",
      "src/a.ts",
      "src/core.ts",
    ]);
  });

  it("path and explain refuse an ambiguous or unknown file, naming the candidates", async () => {
    const twice = await cli("path", dir, "index.ts", "core.ts");
    expect(twice.code).toBe(EXIT_ERROR);
    expect(twice.stderr).toContain(
      "epoch: index.ts matches 2 files; name one of them.\n  lib/index.ts\n  src/index.ts\n",
    );
    const none = await cli("explain", dir, "missing.ts");
    expect(none.code).toBe(EXIT_ERROR);
    expect(none.stderr).toContain("No analyzed file matches missing.ts.");
    expect((await cli("explain", dir)).stderr).toContain("Usage:");
  });

  it("explain: one file's facts", async () => {
    const r = await cli("explain", dir, "src/core.ts");
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain(
      "src/core.ts\n  language     typescript, tier A\n",
    );
    expect(r.stdout).toContain("  dependents   3 (direct and indirect)\n");
    expect(r.stdout).toContain("  commits      2 in the last 90 days\n");
    expect(r.stdout).toContain("  imported by (1):\n    src/a.ts\n");
    const json = JSON.parse(
      (await cli("explain", dir, "core.ts", "--json")).stdout,
    ) as {
      id: string;
      risk: { tier: string };
    };
    expect(json).toMatchObject({ id: "src/core.ts", risk: { tier: "low" } });
  });

  it("export: to stdout, or to the file named with --out, and nowhere else", async () => {
    const before = fs.readdirSync(dir).sort();
    const dot = await cli("export", dir, "--format", "dot", "--scope", "src");
    expect(dot.code).toBe(EXIT_OK);
    expect(dot.stdout).toContain('"src/a.ts" -> "src/core.ts";');
    expect(dot.stdout).not.toContain("lib/index.ts");
    expect(fs.readdirSync(dir).sort()).toEqual(before);

    const out = path.join(cacheDir, "graph.graphml");
    const written = await cli(
      "export",
      dir,
      "--format",
      "graphml",
      "--out",
      out,
    );
    expect(written.code).toBe(EXIT_OK);
    expect(written.stdout).toBe("");
    expect(fs.readFileSync(out, "utf8")).toContain('<node id="src/core.ts">');

    const bad = await cli("export", dir, "--format", "png");
    expect(bad.code).toBe(EXIT_ERROR);
    expect(bad.stderr).toContain(
      "export needs --format graphml, mermaid or dot",
    );
  });
});
