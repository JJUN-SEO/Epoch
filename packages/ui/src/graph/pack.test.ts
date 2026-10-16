import { describe, expect, it } from "vitest";
import type { LayoutRequest } from "./layout-protocol";
import { PACK, PACK_ABOVE_FILES, isLargeGraph, packedLayout } from "./pack";

type Request = Omit<LayoutRequest, "id">;

/** A request from file paths: every folder on the way is a compound node. */
function request(paths: readonly string[]): Request {
  const nodes = new Map<
    string,
    { id: string; parent?: string; size: number }
  >();
  for (const f of paths) {
    const parts = f.split("/");
    let parent: string | undefined;
    for (let i = 1; i < parts.length; i++) {
      const id = `dir:${parts.slice(0, i).join("/")}`;
      if (!nodes.has(id))
        nodes.set(id, { id, size: 14, ...(parent ? { parent } : {}) });
      parent = id;
    }
    nodes.set(f, { id: f, size: 14, ...(parent ? { parent } : {}) });
  }
  return { nodes: [...nodes.values()], edges: [] };
}

const files = (prefix: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}/f${String(i).padStart(3, "0")}.ts`,
  );

/** The rectangle around a set of files' positions. */
function extent(points: readonly { x: number; y: number }[]) {
  return {
    x1: Math.min(...points.map((p) => p.x)),
    x2: Math.max(...points.map((p) => p.x)),
    y1: Math.min(...points.map((p) => p.y)),
    y2: Math.max(...points.map((p) => p.y)),
  };
}

describe("packedLayout", () => {
  const paths = [
    ...files("big/a", 30),
    ...files("big/b", 30),
    ...files("big/a/deep", 7),
    ...files("big", 5),
    ...files("small/x", 3),
    "root.ts",
  ];
  const req = request(paths);
  const { positions, frames } = packedLayout(req);

  it("places every file, and no folder", () => {
    expect(Object.keys(positions).sort()).toEqual([...paths].sort());
  });

  it("never puts two files closer than a grid cell", () => {
    const all = Object.values(positions);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i];
        const b = all[j];
        if (!a || !b) continue;
        expect(
          Math.abs(a.x - b.x) >= PACK.cellWidth ||
            Math.abs(a.y - b.y) >= PACK.cellHeight,
        ).toBe(true);
      }
    }
  });

  it("keeps sibling folders' files in separate areas", () => {
    // Each folder's files (with its subfolders) fill one area; siblings do not overlap.
    const area = (prefix: string) =>
      extent(
        Object.entries(positions)
          .filter(([id]) => id.startsWith(`${prefix}/`))
          .map(([, p]) => p),
      );
    const a = area("big/a");
    const b = area("big/b");
    const apart = a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1;
    expect(apart).toBe(true);
    // big/a/deep sits inside big/a's area.
    const deep = area("big/a/deep");
    expect(deep.x1).toBeGreaterThanOrEqual(a.x1);
    expect(deep.x2).toBeLessThanOrEqual(a.x2);
    expect(deep.y1).toBeGreaterThanOrEqual(a.y1);
    expect(deep.y2).toBeLessThanOrEqual(a.y2);
  });

  it("lays a folder's own files out in name order", () => {
    const own = files("big/b", 30).map((f) => positions[f]);
    const order = (p: { x: number; y: number } | undefined) =>
      p ? p.y * 1e6 + p.x : 0;
    expect(own.map(order)).toEqual([...own.map(order)].sort((x, y) => x - y));
  });

  it("gives every open folder a rectangle around its files, inside its parent's", () => {
    expect(Object.keys(frames).sort()).toEqual([
      "dir:big",
      "dir:big/a",
      "dir:big/a/deep",
      "dir:big/b",
      "dir:small",
      "dir:small/x",
    ]);
    const inside = (id: string, frame: string) => {
      const p = positions[id];
      const f = frames[frame];
      if (!p || !f) return false;
      return (
        Math.abs(p.x - f.x) < f.width / 2 && Math.abs(p.y - f.y) < f.height / 2
      );
    };
    for (const f of files("big/a/deep", 7)) {
      expect(inside(f, "dir:big/a/deep")).toBe(true);
      expect(inside(f, "dir:big/a")).toBe(true);
      expect(inside(f, "dir:big")).toBe(true);
      expect(inside(f, "dir:small")).toBe(false);
    }
    const a = frames["dir:big/a"];
    const b = frames["dir:big/b"];
    if (!a || !b) throw new Error("missing frames");
    const apart =
      Math.abs(a.x - b.x) >= (a.width + b.width) / 2 ||
      Math.abs(a.y - b.y) >= (a.height + b.height) / 2;
    expect(apart).toBe(true);
  });

  it("makes room for closed folders, which are drawn larger than files", () => {
    const big = {
      nodes: [
        { id: "dir:x", size: 100 },
        { id: "dir:y", size: 100 },
        { id: "z.ts", size: 14 },
      ],
      edges: [],
    };
    const p = packedLayout(big).positions;
    const [x, y] = [p["dir:x"], p["dir:y"]];
    if (!x || !y) throw new Error("missing positions");
    expect(Math.abs(x.x - y.x) >= 100 || Math.abs(x.y - y.y) >= 100).toBe(true);
  });

  it("is centered on the origin and deterministic", () => {
    const e = extent(Object.values(positions));
    expect(Math.abs(e.x1 + e.x2)).toBeLessThan(PACK.cellWidth * 2);
    expect(Math.abs(e.y1 + e.y2)).toBeLessThan(PACK.cellHeight * 2);
    expect(packedLayout(request([...paths].reverse()))).toEqual({
      positions,
      frames,
    });
  });
});

describe("isLargeGraph", () => {
  const leaves = (n: number) =>
    Array.from({ length: n }, () => ({ kind: "file", collapsed: false }));
  it("counts files and closed folders, not open folders", () => {
    expect(isLargeGraph({ nodes: leaves(PACK_ABOVE_FILES) })).toBe(false);
    expect(
      isLargeGraph({
        nodes: [...leaves(PACK_ABOVE_FILES), { kind: "dir", collapsed: false }],
      }),
    ).toBe(false);
    expect(
      isLargeGraph({
        nodes: [...leaves(PACK_ABOVE_FILES), { kind: "dir", collapsed: true }],
      }),
    ).toBe(true);
  });
});
