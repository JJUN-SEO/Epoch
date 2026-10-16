import { describe, expect, it } from "vitest";
import type { Graph, GraphEdge, GraphNode } from "./schemas/index.js";
import {
  StoredSummary,
  folderJob,
  summaryDependencies,
  summaryKeyText,
  summaryOrder,
  summaryStatus,
  type SummaryRef,
} from "./summaries.js";

/*
 * Summaries (M7) are cached by what was sent: a file summary is reused
 * while the file is unchanged, and stays visible, marked stale, when the
 * file or the summaries it was given change.
 */

const node = (id: string): GraphNode => ({
  id,
  kind: id.startsWith("pkg:") ? "package" : "file",
  language: "typescript",
  loc: 1,
  contentHash: id,
  exports: [],
  externals: [],
  flags: [],
  metrics: { fanIn: 0, fanOut: 0 },
});

const edge = (
  source: string,
  target: string,
  kind: GraphEdge["kind"] = "import",
): GraphEdge => ({
  source,
  target,
  kind,
  provenance: kind === "cochange" ? "git-cochange" : "resolver",
  confidence: kind === "cochange" ? 0.8 : 1,
  evidence: [],
});

const graph = (ids: string[], edges: GraphEdge[] = []): Graph => ({
  schemaVersion: 2,
  nodes: ids.map(node),
  edges,
  roots: [],
  findings: [],
  unresolved: [],
});

const hex = (n: number) => n.toString(16).padStart(64, "0");

const summary = (
  subject: string,
  contentHash: string,
  used: SummaryRef[] = [],
): StoredSummary =>
  StoredSummary.parse({
    subject,
    provider: "anthropic",
    model: "m",
    promptVersion: 1,
    contentHash,
    text: `About ${subject}.`,
    used,
    createdAt: "2026-10-16T12:00:00.000Z",
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
  });

describe("summaryKeyText", () => {
  const base = {
    promptVersion: 1,
    provider: "anthropic",
    model: "m",
    subject: "src/a.ts",
    contentHash: "h1",
  };

  it("names everything the text depends on, in a fixed order", () => {
    expect(summaryKeyText(base)).toBe(summaryKeyText({ ...base }));
    for (const change of [
      { promptVersion: 2 },
      { provider: "local" },
      { model: "n" },
      { subject: "src/b.ts" },
      { contentHash: "h2" },
    ]) {
      expect(summaryKeyText({ ...base, ...change })).not.toBe(
        summaryKeyText(base),
      );
    }
  });
});

describe("summaryStatus", () => {
  const dep = (subject: string, n: number): SummaryRef => ({
    subject,
    hash: hex(n),
  });

  it.each([
    {
      name: "nothing stored",
      hit: undefined,
      latest: undefined,
      deps: [],
      want: "missing",
    },
    {
      name: "a summary of this content, with the same inputs",
      hit: summary("a", "h1", [dep("b", 1)]),
      latest: undefined,
      deps: [dep("b", 1)],
      want: "fresh",
    },
    {
      name: "inputs listed in another order",
      hit: summary("a", "h1", [dep("b", 1), dep("c", 2)]),
      latest: undefined,
      deps: [dep("c", 2), dep("b", 1)],
      want: "fresh",
    },
    {
      name: "a dependency's summary changed",
      hit: summary("a", "h1", [dep("b", 1)]),
      latest: undefined,
      deps: [dep("b", 2)],
      want: "stale:dependencies",
    },
    {
      name: "a dependency was summarized since",
      hit: summary("a", "h1"),
      latest: undefined,
      deps: [dep("b", 1)],
      want: "stale:dependencies",
    },
    {
      name: "the file changed; an older summary remains",
      hit: undefined,
      latest: summary("a", "h0"),
      deps: [],
      want: "stale:file",
    },
  ])("$name: $want", ({ hit, latest, deps, want }) => {
    const s = summaryStatus({ hit, latest, currentDeps: deps });
    expect(s.state === "stale" ? `stale:${s.why}` : s.state).toBe(want);
    if (s.state === "fresh") expect(s.summary).toBe(hit);
    if (s.state === "stale")
      expect(s.previous).toBe(s.why === "file" ? latest : hit);
  });

  it("is fresh exactly when the content and the summaries used match (seeded property test)", () => {
    // A model of the cache: content versions and summary generations per
    // subject, keys standing in for hashes. The oracle remembers, per
    // subject and content version, the inputs of the last generation.
    let seed = 20261016;
    const next = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const subjects = ["a", "b", "c", "d"];
    const depsOf: Record<string, string[]> = {
      a: ["b", "c"],
      b: ["c"],
      c: [],
      d: ["a", "c"],
    };
    const version: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    const byKey = new Map<string, StoredSummary>();
    const latestKey = new Map<string, string>();
    const oracle = new Map<string, string>();
    let generation = 0;
    const keyOf = (s: string) => `${s}@${String(version[s])}`;
    const textHash = new Map<string, string>();
    const currentDeps = (s: string): SummaryRef[] =>
      (depsOf[s] ?? []).flatMap((d) => {
        const k = latestKey.get(d);
        return k === undefined
          ? []
          : [{ subject: d, hash: textHash.get(k) ?? "" }];
      });
    const inputs = (s: string) =>
      JSON.stringify(
        currentDeps(s)
          .map((r) => `${r.subject}=${r.hash}`)
          .sort(),
      );

    for (let step = 0; step < 3000; step++) {
      const s = subjects[Math.floor(next() * subjects.length)] ?? "a";
      const op = next();
      if (op < 0.3) {
        version[s] = (version[s] ?? 0) + 1;
      } else if (op < 0.45) {
        // Back to an earlier version (a branch switch).
        version[s] = Math.floor(next() * ((version[s] ?? 0) + 1));
      } else {
        generation++;
        const key = keyOf(s);
        const stored = summary(s, key, currentDeps(s));
        byKey.set(key, stored);
        latestKey.set(s, key);
        textHash.set(key, hex(generation));
        oracle.set(key, inputs(s));
      }
      for (const t of subjects) {
        const key = keyOf(t);
        const latest = latestKey.get(t);
        const status = summaryStatus({
          hit: byKey.get(key),
          latest: latest === undefined ? undefined : byKey.get(latest),
          currentDeps: currentDeps(t),
        });
        const expected = !oracle.has(key)
          ? latest === undefined
            ? "missing"
            : "stale:file"
          : oracle.get(key) === inputs(t)
            ? "fresh"
            : "stale:dependencies";
        const got =
          status.state === "stale" ? `stale:${status.why}` : status.state;
        expect(got, `step ${String(step)}, subject ${t}`).toBe(expected);
      }
    }
  });
});

describe("StoredSummary", () => {
  it("caps the text and rejects anything unexpected", () => {
    const ok = summary("a", "h");
    expect(StoredSummary.safeParse(ok).success).toBe(true);
    expect(
      StoredSummary.safeParse({ ...ok, text: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(StoredSummary.safeParse({ ...ok, source: "code" }).success).toBe(
      false,
    );
    expect(
      StoredSummary.safeParse({
        ...ok,
        used: [{ subject: "b", hash: "short" }],
      }).success,
    ).toBe(false);
  });
});

describe("summaryDependencies", () => {
  it("lists direct fact dependencies, not hints, sorted", () => {
    const g = graph(
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      [
        edge("a.ts", "c.ts"),
        edge("a.ts", "b.ts", "type-only"),
        edge("a.ts", "d.ts", "cochange"),
        edge("a.ts", "e.ts", "via-barrel"),
        edge("b.ts", "a.ts"),
        edge("a.ts", "a.ts"),
      ],
    );
    expect(summaryDependencies(g, "a.ts")).toEqual(["b.ts", "c.ts"]);
    expect(summaryDependencies(g, "c.ts")).toEqual([]);
  });
});

describe("summaryOrder", () => {
  it("puts dependencies first, a cycle as one group, ties by id", () => {
    const g = graph(
      ["app.ts", "util.ts", "x.ts", "y.ts", "lone.ts"],
      [
        edge("app.ts", "x.ts"),
        edge("x.ts", "y.ts"),
        edge("y.ts", "x.ts"),
        edge("y.ts", "util.ts"),
      ],
    );
    expect(
      summaryOrder(
        g,
        g.nodes.map((n) => n.id),
      ),
    ).toEqual([["lone.ts"], ["util.ts"], ["x.ts", "y.ts"], ["app.ts"]]);
  });

  it("orders only the subjects asked for, through edges between them", () => {
    const g = graph(
      ["a.ts", "b.ts", "c.ts"],
      [edge("a.ts", "b.ts"), edge("b.ts", "c.ts")],
    );
    expect(summaryOrder(g, ["a.ts", "c.ts"])).toEqual([["a.ts"], ["c.ts"]]);
    expect(summaryOrder(g, ["c.ts", "a.ts", "b.ts"])).toEqual([
      ["c.ts"],
      ["b.ts"],
      ["a.ts"],
    ]);
  });
});

describe("folderJob", () => {
  it("summarizes files bottom-up, then folders deepest first, the folder last", () => {
    const g = graph(
      [
        "src/main.ts",
        "src/lib/a.ts",
        "src/lib/b.ts",
        "src/lib/deep/c.ts",
        "other/x.ts",
      ],
      [
        edge("src/main.ts", "src/lib/a.ts"),
        edge("src/lib/a.ts", "src/lib/b.ts"),
      ],
    );
    expect(folderJob(g, "src")).toEqual([
      "src/lib/b.ts",
      "src/lib/deep/c.ts",
      "src/lib/a.ts",
      "src/main.ts",
      "dir:src/lib/deep",
      "dir:src/lib",
      "dir:src",
    ]);
    expect(folderJob(g, "")).toContain("dir:");
    expect(folderJob(g, "nope")).toEqual([]);
  });
});
