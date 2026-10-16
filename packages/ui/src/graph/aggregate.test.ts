import { describe, expect, it } from "vitest";
import {
  INITIAL_NODE_BUDGET,
  aggregate,
  ancestors,
  dirId,
  expandTo,
  initialExpanded,
  representative,
  searchNodes,
} from "./aggregate";
import { edge, graph } from "./test-graph";

const ids = (xs: readonly { id: string }[]) => xs.map((x) => x.id);

describe("ancestors and representative", () => {
  it("lists the directories above a node, outermost first", () => {
    expect(ancestors("a/b/c.ts")).toEqual(["a", "a/b"]);
    expect(ancestors("top.ts")).toEqual([]);
    expect(ancestors("pkg:example.com/x/y")).toEqual([]);
    const g = graph(["pkg:example.com/x", "pkg:example.com/x/y/z"]);
    expect(ancestors("pkg:example.com/x/y/z", g)).toEqual(["y", "y/z"]);
    expect(ancestors("pkg:example.com/x", g)).toEqual([]);
  });

  it("draws a node as its outermost collapsed directory", () => {
    expect(representative("a/b/c.ts", new Set())).toBe(dirId("a"));
    expect(representative("a/b/c.ts", new Set(["a"]))).toBe(dirId("a/b"));
    expect(representative("a/b/c.ts", new Set(["a", "a/b"]))).toBe("a/b/c.ts");
    // A collapsed parent hides an expanded child.
    expect(representative("a/b/c.ts", new Set(["a/b"]))).toBe(dirId("a"));
  });
});

describe("aggregate", () => {
  const g = graph(
    [
      "src/app.ts",
      "src/lib/a.ts",
      "src/lib/b.ts",
      "src/lib/deep/c.ts",
      "main.ts",
    ],
    [
      edge("main.ts", "src/app.ts"),
      edge("src/app.ts", "src/lib/a.ts"),
      edge("src/app.ts", "src/lib/b.ts", "type-only"),
      edge("src/lib/a.ts", "src/lib/b.ts"),
      edge("src/lib/b.ts", "src/lib/deep/c.ts"),
    ],
  );

  it("shows every file inside compound directories when all are expanded", () => {
    const v = aggregate(g, {
      expanded: initialExpanded(g),
      showViaBarrel: false,
    });
    expect(ids(v.nodes)).toEqual([
      "dir:src",
      "dir:src/lib",
      "dir:src/lib/deep",
      "main.ts",
      "src/app.ts",
      "src/lib/a.ts",
      "src/lib/b.ts",
      "src/lib/deep/c.ts",
    ]);
    const byId = new Map(v.nodes.map((n) => [n.id, n]));
    expect(byId.get("src/lib/a.ts")?.parent).toBe("dir:src/lib");
    expect(byId.get("dir:src/lib")).toMatchObject({
      parent: "dir:src",
      collapsed: false,
      fileCount: 3,
    });
    expect(byId.get("main.ts")?.parent).toBeUndefined();
    expect(v.edges).toHaveLength(5);
  });

  it("merges a collapsed directory's files and edges, with counts", () => {
    const v = aggregate(g, {
      expanded: new Set(["src"]),
      showViaBarrel: false,
    });
    expect(ids(v.nodes)).toEqual([
      "dir:src",
      "dir:src/lib",
      "main.ts",
      "src/app.ts",
    ]);
    expect(v.nodes.find((n) => n.id === "dir:src/lib")).toMatchObject({
      collapsed: true,
      fileCount: 3,
      parent: "dir:src",
    });
    // app -> a and app -> b merge; a -> b and b -> deep/c fall inside lib.
    expect(v.edges).toEqual([
      {
        id: "main.ts->src/app.ts",
        source: "main.ts",
        target: "src/app.ts",
        hint: false,
        kinds: ["import"],
        count: 1,
      },
      {
        id: "src/app.ts->dir:src/lib",
        source: "src/app.ts",
        target: "dir:src/lib",
        hint: false,
        kinds: ["import", "type-only"],
        count: 2,
      },
    ]);
  });

  it("collapses everything to top-level directories when nothing is expanded", () => {
    const v = aggregate(g, { expanded: new Set(), showViaBarrel: false });
    expect(ids(v.nodes)).toEqual(["dir:src", "main.ts"]);
    expect(ids(v.edges)).toEqual(["main.ts->dir:src"]);
  });

  it("hides via-barrel and hint edges unless asked, and draws hints at or above the threshold, dashed", () => {
    const h = graph(
      ["a.ts", "b.ts", "c.ts", "index.ts"],
      [
        edge("a.ts", "index.ts", "via-barrel"),
        edge("a.ts", "b.ts"),
        {
          ...edge("a.ts", "b.ts", "cochange", 0.8),
          evidence: ["changed in 4 of the 5 commits that changed b.ts"],
        },
        edge("c.ts", "b.ts", "shared-string", 0.3),
      ],
    );
    const facts = aggregate(h, { expanded: new Set(), showViaBarrel: false });
    expect(facts.edges.map((e) => [e.id, e.hint])).toEqual([
      ["a.ts->b.ts", false],
    ]);
    const hints = aggregate(h, {
      expanded: new Set(),
      showViaBarrel: false,
      hintThreshold: 0.5,
    });
    expect(hints.edges.map((e) => [e.id, e.hint])).toEqual([
      ["a.ts->b.ts", false],
      ["a.ts->b.ts (hint)", true],
    ]);
    expect(hints.edges[1]?.detail).toBe(
      "Likely relation (co-change, 0.80): changed in 4 of the 5 commits that changed b.ts",
    );
    expect(hints.edges[0]?.detail).toBeUndefined();
    expect(
      ids(
        aggregate(h, {
          expanded: new Set(),
          showViaBarrel: false,
          hintThreshold: 0.2,
        }).edges,
      ),
    ).toContain("c.ts->b.ts (hint)");
    const shown = aggregate(h, { expanded: new Set(), showViaBarrel: true });
    expect(ids(shown.edges)).toContain("a.ts->index.ts");
  });

  it("merges hints into a closed folder, naming how many and the strongest", () => {
    const h = graph(
      ["x/a.ts", "x/b.ts", "c.ts"],
      [
        edge("c.ts", "x/a.ts", "cochange", 0.6),
        edge("c.ts", "x/b.ts", "shared-string", 0.7),
      ],
    );
    const v = aggregate(h, {
      expanded: new Set(),
      showViaBarrel: false,
      hintThreshold: 0.5,
    });
    expect(v.edges.map((e) => [e.id, e.detail])).toEqual([
      ["c.ts->dir:x (hint)", "2 likely relations, the strongest 0.70"],
    ]);
  });

  it("puts Go package nodes in their folders (ADR-013)", () => {
    const p = graph([
      "pkg:example.com/m",
      "pkg:example.com/m/a",
      "pkg:example.com/m/b",
    ]);
    const v = aggregate(p, {
      expanded: new Set(["a"]),
      showViaBarrel: false,
    });
    expect(v.nodes.map((n) => [n.id, n.kind, n.parent])).toEqual([
      [dirId("a"), "dir", undefined],
      [dirId("b"), "dir", undefined],
      ["pkg:example.com/m", "package", undefined],
      ["pkg:example.com/m/a", "package", dirId("a")],
    ]);
  });
});

describe("initialExpanded, expandTo and searchNodes", () => {
  it("opens folders breadth-first while the drawn nodes fit the budget", () => {
    const small = graph(["a/b/c.ts"]);
    expect([...initialExpanded(small)].sort()).toEqual(["a", "a/b"]);
    // One folder with more files than the budget stays closed.
    const big = graph(
      Array.from(
        { length: INITIAL_NODE_BUDGET + 1 },
        (_, i) => `d/f${String(i)}.ts`,
      ),
    );
    expect(initialExpanded(big).size).toBe(0);
    // Shallow folders open first; a deep one that would overflow stays closed.
    const mixed = graph([
      "top.ts",
      "x/1.ts",
      "x/y/2.ts",
      "x/y/3.ts",
      "x/y/4.ts",
      "z/5.ts",
    ]);
    // Root: top.ts, x, z (3). Open x: + x/1.ts, x/y (4). Open z: + z/5.ts (4).
    // Open x/y: + three files (6), over a budget of 5.
    expect([...initialExpanded(mixed, 5)].sort()).toEqual(["x", "z"]);
    expect([...initialExpanded(mixed, 6)].sort()).toEqual(["x", "x/y", "z"]);
  });

  it("opens the directories above a node or a directory", () => {
    expect([...expandTo(new Set(["x"]), "a/b/c.ts")].sort()).toEqual([
      "a",
      "a/b",
      "x",
    ]);
    expect([...expandTo(new Set(), dirId("a/b"))]).toEqual(["a"]);
  });

  it("finds nodes by a case-insensitive path substring", () => {
    const s = graph(["src/App.tsx", "src/lib/app-util.ts", "README.ts"]);
    expect(searchNodes(s, "APP")).toEqual([
      "src/App.tsx",
      "src/lib/app-util.ts",
    ]);
    expect(searchNodes(s, "  ")).toEqual([]);
    expect(searchNodes(s, "app", 1)).toEqual(["src/App.tsx"]);
  });
});
