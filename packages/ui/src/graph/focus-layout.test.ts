import { describe, expect, it } from "vitest";
import {
  FOCUS_COLUMN_GAP as X,
  FOCUS_ROW_GAP as Y,
  focusLayout,
  groupId,
} from "./focus-layout";
import { neighborhood } from "./neighborhood";
import { edge, graph } from "./test-graph";

const layout = (
  g: ReturnType<typeof graph>,
  center: string,
  options: { hops?: 1 | 2 | 3; max?: number; expanded?: string[] } = {},
) =>
  focusLayout(
    neighborhood(g, center, { hops: options.hops ?? 1, showViaBarrel: false }),
    {
      maxPerColumn: options.max ?? 40,
      expandedGroups: new Set(options.expanded ?? []),
    },
  );

const at = (l: ReturnType<typeof focusLayout>) =>
  Object.fromEntries(l.nodes.map((n) => [n.id, n.position]));

/** Nodes in reading order: column by column, top to bottom. */
const reading = (l: ReturnType<typeof focusLayout>) =>
  [...l.nodes].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
  );

describe("focusLayout", () => {
  it("centers the file, imports to the right, dependents to the left, one column per hop", () => {
    const g = graph(
      ["src/app.ts", "src/b.ts", "src/c.ts", "lib/x.ts", "lib/y.ts", "top.ts"],
      [
        edge("src/app.ts", "src/c.ts"),
        edge("src/app.ts", "src/b.ts"),
        edge("src/b.ts", "lib/x.ts"),
        edge("top.ts", "src/app.ts"),
        edge("lib/y.ts", "src/app.ts"),
      ],
    );
    const l = layout(g, "src/app.ts", { hops: 2 });
    expect(at(l)).toEqual({
      "src/app.ts": { x: 0, y: 0 },
      // imports, depth 1, sorted by path
      "src/b.ts": { x: X, y: -Y / 2 },
      "src/c.ts": { x: X, y: Y / 2 },
      // imports, depth 2
      "lib/x.ts": { x: 2 * X, y: 0 },
      // dependents, depth 1
      "lib/y.ts": { x: -X, y: -Y / 2 },
      "top.ts": { x: -X, y: Y / 2 },
    });
    const center = l.nodes.find((n) => n.id === "src/app.ts");
    expect(center).toMatchObject({
      kind: "center",
      side: "center",
      depth: 0,
      label: "app.ts",
      detail: "src",
    });
    expect(l.nodes.find((n) => n.id === "top.ts")).toMatchObject({
      kind: "file",
      side: "dependents",
      depth: 1,
      detail: "",
      cycle: false,
    });
  });

  it("draws a file on both sides once, on the imports side, marked as a cycle", () => {
    const g = graph(
      ["a.ts", "b.ts"],
      [edge("a.ts", "b.ts"), edge("b.ts", "a.ts")],
    );
    const l = layout(g, "a.ts");
    expect(l.nodes.map((n) => [n.id, n.side, n.cycle])).toEqual([
      ["a.ts", "center", false],
      ["b.ts", "imports", true],
    ]);
    expect(l.edges.map((e) => e.id)).toEqual(["a.ts->b.ts", "b.ts->a.ts"]);
  });

  it("groups a crowded column by folder, merging edges, and expands a group on request", () => {
    const files = [
      "ui/a.ts",
      "ui/b.ts",
      "ui/c.ts",
      "api/d.ts",
      "api/e.ts",
      "solo/f.ts",
    ];
    const g = graph(
      ["core.ts", ...files],
      files.map((f) => edge(f, "core.ts")),
    );
    const l = layout(g, "core.ts", { max: 3 });
    expect(reading(l).map((n) => [n.id, n.kind, n.members.length])).toEqual([
      [groupId("dependents", 1, "api"), "group", 2],
      ["solo/f.ts", "file", 1], // a one-file group is just the file
      [groupId("dependents", 1, "ui"), "group", 3],
      ["core.ts", "center", 1],
    ]);
    expect(reading(l)[0]).toMatchObject({ label: "api", detail: "2 files" });
    expect(l.edges).toContainEqual({
      id: `${groupId("dependents", 1, "ui")}->core.ts`,
      source: groupId("dependents", 1, "ui"),
      target: "core.ts",
      kinds: ["import"],
      hint: false,
      outward: true,
      count: 3,
    });

    const open = layout(g, "core.ts", {
      max: 3,
      expanded: [groupId("dependents", 1, "ui")],
    });
    expect(reading(open).map((n) => n.id)).toEqual([
      groupId("dependents", 1, "api"),
      "solo/f.ts",
      "ui/a.ts",
      "ui/b.ts",
      "ui/c.ts",
      "core.ts",
    ]);
  });

  it("coarsens the grouping to parent folders until the column fits", () => {
    const files = ["a/x/1.ts", "a/y/2.ts", "a/z/3.ts", "b/w/4.ts", "b/v/5.ts"];
    const g = graph(
      ["c.ts", ...files],
      files.map((f) => edge("c.ts", f)),
    );
    const l = layout(g, "c.ts", { max: 2 });
    expect(reading(l).map((n) => n.id)).toEqual([
      "c.ts",
      groupId("imports", 1, "a"),
      groupId("imports", 1, "b"),
    ]);
  });

  it("drops edges inside a group and leaves small columns alone", () => {
    const g = graph(
      ["c.ts", "p/a.ts", "p/b.ts", "q/d.ts"],
      [
        edge("c.ts", "p/a.ts"),
        edge("c.ts", "p/b.ts"),
        edge("c.ts", "q/d.ts"),
        edge("p/a.ts", "p/b.ts"),
      ],
    );
    expect(layout(g, "c.ts").nodes).toHaveLength(4);
    const grouped = layout(g, "c.ts", { max: 2 });
    expect(grouped.edges.map((e) => e.id)).toEqual([
      `c.ts->${groupId("imports", 1, "p")}`,
      "c.ts->q/d.ts",
    ]);
  });
});
