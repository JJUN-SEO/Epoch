import { describe, expect, it } from "vitest";
import { edge, graph } from "../graph/test-graph";
import {
  carryPositions,
  edgesByNode,
  graph3dData,
  sameLayoutInput,
} from "./data";

describe("graph3dData", () => {
  const g = graph(
    ["src/b.ts", "src/a.ts", "lib/c.ts", "index.ts"],
    [
      edge("src/a.ts", "src/b.ts"),
      edge("src/a.ts", "src/b.ts", "type-only"),
      edge("index.ts", "src/a.ts", "via-barrel"),
      edge("index.ts", "lib/c.ts"),
      edge("lib/c.ts", "lib/c.ts"),
      edge("src/b.ts", "lib/c.ts", "cochange", 0.6),
    ],
  );

  it("indexes every file, sorted, with its parent folder as its group", () => {
    const d = graph3dData(g, { showViaBarrel: false });
    expect(d.ids).toEqual(["index.ts", "lib/c.ts", "src/a.ts", "src/b.ts"]);
    expect([...d.groups]).toEqual([0, 1, 2, 2]);
    expect(d.languages).toEqual([
      "typescript",
      "typescript",
      "typescript",
      "typescript",
    ]);
  });

  it("draws the 2D graph's edges once per pair, without self-loops", () => {
    const d = graph3dData(g, { showViaBarrel: false, hintThreshold: 0.5 });
    // index -> lib/c, src/a -> src/b (import + type-only merged), src/b -> lib/c (hint)
    expect([...d.links]).toEqual([0, 1, 2, 3, 3, 1]);
    expect(d.hints).toEqual([false, false, true]);
  });

  it("adds via-barrel and hint edges only when asked", () => {
    const d = graph3dData(g, { showViaBarrel: true, hintThreshold: 0.5 });
    expect([...d.links]).toEqual([0, 1, 0, 2, 2, 3, 3, 1]);
    const facts = graph3dData(g, { showViaBarrel: false });
    expect([...facts.links]).toEqual([0, 1, 2, 3]);
    expect(
      graph3dData(g, { showViaBarrel: false, hintThreshold: 0.7 }).hints,
    ).toEqual([false, false]);
  });

  it("lists each node's outgoing and incoming edges", () => {
    const d = graph3dData(g, { showViaBarrel: false, hintThreshold: 0.5 });
    const { out, into } = edgesByNode(d);
    expect(out).toEqual([[0], [], [1], [2]]);
    expect(into).toEqual([[], [0, 2], [], [1]]);
  });
});

describe("sameLayoutInput", () => {
  const g = graph(
    ["src/b.ts", "src/a.ts", "lib/c.ts"],
    [
      edge("src/a.ts", "src/b.ts"),
      edge("src/b.ts", "lib/c.ts", "cochange", 0.6),
    ],
  );
  const facts = graph3dData(g, { showViaBarrel: false });

  it("is true for the same files, folders and edges", () => {
    // A new graph object with the same drawn content, as when an update
    // only adds hint edges the view hides.
    expect(
      sameLayoutInput(facts, graph3dData(g, { showViaBarrel: false })),
    ).toBe(true);
  });

  it("is false when a file or an edge differs", () => {
    const more = graph3dData(g, { showViaBarrel: false, hintThreshold: 0.5 });
    expect(sameLayoutInput(facts, more)).toBe(false);
    const fewer = graph3dData(
      graph(["src/a.ts", "src/b.ts"], [edge("src/a.ts", "src/b.ts")]),
      { showViaBarrel: false },
    );
    expect(sameLayoutInput(facts, fewer)).toBe(false);
  });
});

describe("carryPositions", () => {
  const before = graph3dData(
    graph(["a/x.ts", "a/y.ts", "b/z.ts"], [edge("a/x.ts", "b/z.ts")]),
    { showViaBarrel: false },
  );
  // x, y, z at known places.
  const placed = new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0]);

  it("keeps each known file's place and puts a new one at its neighbors' center", () => {
    const after = graph3dData(
      graph(
        ["a/x.ts", "a/y.ts", "b/z.ts", "c/new.ts"],
        [
          edge("a/x.ts", "b/z.ts"),
          edge("c/new.ts", "a/x.ts"),
          edge("c/new.ts", "b/z.ts"),
        ],
      ),
      { showViaBarrel: false },
    );
    const carried = carryPositions(before, placed, after);
    if (!carried) throw new Error("expected positions");
    const at = (id: string) => {
      const i = after.ids.indexOf(id);
      return [...carried.slice(3 * i, 3 * i + 3)];
    };
    expect(at("a/x.ts")).toEqual([0, 0, 0]);
    expect(at("a/y.ts")).toEqual([10, 0, 0]);
    expect(at("b/z.ts")).toEqual([0, 20, 0]);
    expect(at("c/new.ts")).toEqual([0, 10, 0]);
  });

  it("puts a new file with no placed neighbor at its folder's center", () => {
    const after = graph3dData(
      graph(
        ["a/x.ts", "a/y.ts", "a/w.ts", "b/z.ts"],
        [edge("a/x.ts", "b/z.ts")],
      ),
      { showViaBarrel: false },
    );
    const carried = carryPositions(before, placed, after);
    if (!carried) throw new Error("expected positions");
    const i = after.ids.indexOf("a/w.ts");
    expect([...carried.slice(3 * i, 3 * i + 3)]).toEqual([5, 0, 0]);
  });

  it("has nothing to carry when no file is shared", () => {
    const other = graph3dData(graph(["q.ts"], []), { showViaBarrel: false });
    expect(carryPositions(before, placed, other)).toBeUndefined();
  });
});
