import { describe, expect, it } from "vitest";
import { neighborhood, sideOf } from "./neighborhood";
import { edge, graph } from "./test-graph";

const opts = { hops: 1, showViaBarrel: false } as const;

describe("neighborhood", () => {
  it("lists direct imports and dependents of the center", () => {
    const g = graph(
      ["a.ts", "b.ts", "c.ts", "d.ts"],
      [edge("a.ts", "b.ts"), edge("b.ts", "c.ts"), edge("d.ts", "b.ts")],
    );
    const n = neighborhood(g, "b.ts", opts);
    expect(n.center).toBe("b.ts");
    expect(n.neighbors).toEqual([
      { id: "a.ts", dependentDepth: 1, dependentVia: "b.ts" },
      { id: "c.ts", importDepth: 1, importVia: "b.ts" },
      { id: "d.ts", dependentDepth: 1, dependentVia: "b.ts" },
    ]);
  });

  it("follows a chain up to the hop limit, recording the hop before", () => {
    const g = graph(
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
      [
        edge("a.ts", "b.ts"),
        edge("b.ts", "c.ts"),
        edge("c.ts", "d.ts"),
        edge("d.ts", "e.ts"),
      ],
    );
    expect(neighborhood(g, "a.ts", opts).neighbors.map((x) => x.id)).toEqual([
      "b.ts",
    ]);
    const three = neighborhood(g, "a.ts", { ...opts, hops: 3 });
    expect(three.neighbors).toEqual([
      { id: "b.ts", importDepth: 1, importVia: "a.ts" },
      { id: "c.ts", importDepth: 2, importVia: "b.ts" },
      { id: "d.ts", importDepth: 3, importVia: "c.ts" },
    ]);
    const up = neighborhood(g, "e.ts", { ...opts, hops: 2 });
    expect(up.neighbors).toEqual([
      { id: "c.ts", dependentDepth: 2, dependentVia: "d.ts" },
      { id: "d.ts", dependentDepth: 1, dependentVia: "e.ts" },
    ]);
  });

  it("takes the shortest distance in a diamond, and the first path by id", () => {
    // a -> b -> d and a -> c -> d
    const g = graph(
      ["a.ts", "b.ts", "c.ts", "d.ts"],
      [
        edge("a.ts", "c.ts"),
        edge("a.ts", "b.ts"),
        edge("b.ts", "d.ts"),
        edge("c.ts", "d.ts"),
      ],
    );
    const n = neighborhood(g, "a.ts", { ...opts, hops: 3 });
    expect(n.neighbors.find((x) => x.id === "d.ts")).toEqual({
      id: "d.ts",
      importDepth: 2,
      importVia: "b.ts",
    });
  });

  it("puts a file on both sides when a cycle runs through the center", () => {
    const g = graph(
      ["a.ts", "b.ts"],
      [edge("a.ts", "b.ts"), edge("b.ts", "a.ts")],
    );
    const [b] = neighborhood(g, "a.ts", opts).neighbors;
    expect(b).toEqual({
      id: "b.ts",
      importDepth: 1,
      importVia: "a.ts",
      dependentDepth: 1,
      dependentVia: "a.ts",
    });
    expect(b && sideOf(b)).toBe("both");
  });

  it("hides via-barrel edges unless asked, like the graph view", () => {
    const g = graph(
      ["app.ts", "index.ts", "core.ts"],
      [
        edge("app.ts", "core.ts"),
        edge("app.ts", "index.ts", "via-barrel"),
        edge("index.ts", "core.ts", "reexport"),
      ],
    );
    expect(neighborhood(g, "app.ts", opts).neighbors.map((x) => x.id)).toEqual([
      "core.ts",
    ]);
    expect(
      neighborhood(g, "app.ts", { ...opts, showViaBarrel: true }).neighbors.map(
        (x) => x.id,
      ),
    ).toEqual(["core.ts", "index.ts"]);
  });

  it("returns the drawn edges among the shown files, merged, marking outward ones", () => {
    // center a imports b and c; b also imports c (an edge between neighbors).
    const g = graph(
      ["a.ts", "b.ts", "c.ts", "z.ts"],
      [
        edge("a.ts", "b.ts"),
        edge("a.ts", "b.ts", "type-only"),
        edge("a.ts", "c.ts"),
        edge("b.ts", "c.ts"),
        edge("c.ts", "z.ts"),
      ],
    );
    expect(neighborhood(g, "a.ts", opts).edges).toEqual([
      {
        id: "a.ts->b.ts",
        source: "a.ts",
        target: "b.ts",
        kinds: ["import", "type-only"],
        hint: false,
        outward: true,
      },
      {
        id: "a.ts->c.ts",
        source: "a.ts",
        target: "c.ts",
        kinds: ["import"],
        hint: false,
        outward: true,
      },
      {
        id: "b.ts->c.ts",
        source: "b.ts",
        target: "c.ts",
        kinds: ["import"],
        hint: false,
        outward: false,
      },
    ]);
  });

  it("returns nothing for an unknown center, and ignores self-loops", () => {
    const g = graph(["a.ts"], [edge("a.ts", "a.ts")]);
    expect(neighborhood(g, "a.ts", opts)).toEqual({
      center: "a.ts",
      neighbors: [],
      edges: [],
    });
    expect(neighborhood(g, "missing.ts", opts).neighbors).toEqual([]);
  });
});
