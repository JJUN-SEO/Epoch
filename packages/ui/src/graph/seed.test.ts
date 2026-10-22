import { describe, expect, it } from "vitest";
import { seedPositions } from "./seed";

const node = (id: string, parent?: string) => ({
  id,
  size: 10,
  ...(parent === undefined ? {} : { parent }),
});
const edge = (source: string, target: string) => ({
  id: `${source}->${target}`,
  source,
  target,
});

describe("seedPositions", () => {
  it("keeps known positions and starts a new node beside a positioned neighbor", () => {
    const out = seedPositions({
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("c", "b")],
      seed: { a: { x: 0, y: 0 }, b: { x: 100, y: 50 } },
    });
    expect(out?.a).toEqual({ x: 0, y: 0 });
    expect(out?.b).toEqual({ x: 100, y: 50 });
    const c = out?.c ?? { x: NaN, y: NaN };
    expect(Math.hypot(c.x - 100, c.y - 50)).toBeCloseTo(30);
  });

  it("starts the files of an opened folder where the folder was drawn", () => {
    const out = seedPositions({
      nodes: [
        node("x"),
        node("dir:d"),
        node("d/1", "dir:d"),
        node("d/2", "dir:d"),
      ],
      edges: [],
      seed: {
        x: { x: 0, y: 0 },
        "dir:d": { x: 200, y: 0 },
        "d/2": { x: 210, y: 0 },
      },
    });
    const one = out?.["d/1"] ?? { x: NaN, y: NaN };
    expect(Math.hypot(one.x - 200, one.y)).toBeCloseTo(30);
    expect(out?.["dir:d"]).toBeUndefined(); // a compound node follows its children
  });

  it("gives up when most nodes are new, and without a seed", () => {
    expect(
      seedPositions({
        nodes: [node("a"), node("b"), node("c")],
        edges: [],
        seed: { a: { x: 0, y: 0 } },
      }),
    ).toBeUndefined();
    expect(seedPositions({ nodes: [node("a")], edges: [] })).toBeUndefined();
  });

  it("is deterministic", () => {
    const req = {
      nodes: [node("a"), node("b")],
      edges: [],
      seed: { a: { x: 1, y: 2 } },
    };
    expect(seedPositions(req)).toEqual(seedPositions(req));
  });
});
