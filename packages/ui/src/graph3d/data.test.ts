import { describe, expect, it } from "vitest";
import { edge, graph } from "../graph/test-graph";
import { edgesByNode, graph3dData } from "./data";

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
    const d = graph3dData(g, false);
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
    const d = graph3dData(g, false);
    // index -> lib/c, src/a -> src/b (import + type-only merged), src/b -> lib/c (hint)
    expect([...d.links]).toEqual([0, 1, 2, 3, 3, 1]);
    expect(d.hints).toEqual([false, false, true]);
  });

  it("adds via-barrel edges only when asked", () => {
    const d = graph3dData(g, true);
    expect([...d.links]).toEqual([0, 1, 0, 2, 2, 3, 3, 1]);
  });

  it("lists each node's outgoing and incoming edges", () => {
    const d = graph3dData(g, false);
    const { out, into } = edgesByNode(d);
    expect(out).toEqual([[0], [], [1], [2]]);
    expect(into).toEqual([[], [0, 2], [], [1]]);
  });
});
