import { describe, expect, it } from "vitest";
import { edge, graph } from "../graph/test-graph";
import {
  carryPositions,
  edgesByNode,
  fitSphere,
  graph3dData,
  sameLayoutInput,
  startingPositions,
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
    // Near its neighbors' center, a little off it, so new files never share a point.
    const [nx = 0, ny = 0, nz = 0] = at("c/new.ts");
    expect(Math.hypot(nx, ny - 10, nz)).toBeGreaterThan(0);
    expect(Math.hypot(nx, ny - 10, nz)).toBeLessThan(5);
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
    const [wx = 0, wy = 0, wz = 0] = carried.slice(3 * i, 3 * i + 3);
    expect(Math.hypot(wx - 5, wy, wz)).toBeLessThan(5);
  });

  it("has nothing to carry when no file is shared", () => {
    const other = graph3dData(graph(["q.ts"], []), { showViaBarrel: false });
    expect(carryPositions(before, placed, other)).toBeUndefined();
  });
});

describe("startingPositions", () => {
  const before = graph3dData(
    graph(["a/x.ts", "a/y.ts", "b/z.ts"], [edge("a/x.ts", "b/z.ts")]),
    { showViaBarrel: false },
  );
  const placed = new Float32Array([0, 0, 0, 10, 0, 0, 0, 20, 0]);
  const after = graph3dData(
    graph(
      ["a/x.ts", "a/y.ts", "b/z.ts"],
      [edge("a/x.ts", "b/z.ts"), edge("a/y.ts", "b/z.ts")],
    ),
    { showViaBarrel: false },
  );

  it("starts from the previous layout once it finished", () => {
    expect(
      startingPositions(
        { data: before, positions: placed, settled: true },
        after,
      ),
    ).toBeDefined();
  });

  it("starts fresh from a layout that had not finished", () => {
    expect(
      startingPositions(
        { data: before, positions: new Float32Array(9), settled: false },
        after,
      ),
    ).toBeUndefined();
    expect(startingPositions(undefined, after)).toBeUndefined();
  });

  it("starts fresh when most files are new", () => {
    const mostlyNew = graph3dData(
      graph(["a/x.ts", "n/1.ts", "n/2.ts", "n/3.ts", "n/4.ts"], []),
      { showViaBarrel: false },
    );
    expect(
      startingPositions(
        { data: before, positions: placed, settled: true },
        mostlyNew,
      ),
    ).toBeUndefined();
  });
});

describe("fitSphere", () => {
  it("frames nearly every file, not the few that drifted far away", () => {
    const n = 100;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) p[3 * i] = (i % 10) - 4.5; // a cluster of radius 4.5
    p[3 * 98] = 5000; // two outliers
    p[3 * 99] = -5000;
    const { center, radius } = fitSphere(p);
    expect(radius).toBeLessThan(10);
    expect(Math.abs(center[0])).toBeLessThan(5);
  });

  it("frames every file of a small graph", () => {
    const { center, radius } = fitSphere(
      new Float32Array([0, 0, 0, 300, 0, 0]),
    );
    expect(radius).toBeCloseTo(150, 0);
    expect(center[0]).toBeCloseTo(150, 0);
  });
});
