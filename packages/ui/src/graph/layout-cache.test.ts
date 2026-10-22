import { describe, expect, it } from "vitest";
import { LayoutCache, layoutKey } from "./layout-cache";
import type { LayoutResponse } from "./layout-protocol";

const request = (ids: string[], edges: [string, string][] = []) => ({
  nodes: ids.map((id) => ({ id, size: 14 })),
  edges: edges.map(([source, target]) => ({
    id: `${source}->${target}`,
    source,
    target,
  })),
});

const response = (id: number): LayoutResponse => ({
  id,
  positions: { a: { x: id, y: 0 } },
  ms: 0,
});

describe("layoutKey", () => {
  it("is the same for the same structure, whatever the seed", () => {
    const a = request(["a", "b"], [["a", "b"]]);
    expect(layoutKey(a)).toBe(layoutKey({ ...a }));
    expect(layoutKey({ ...a, seed: { a: { x: 1, y: 2 } } } as typeof a)).toBe(
      layoutKey(a),
    );
  });

  it("changes with a node, an edge, a folder, a size or the mode", () => {
    const base = layoutKey(request(["a", "b"], [["a", "b"]]));
    expect(layoutKey(request(["a", "b", "c"], [["a", "b"]]))).not.toBe(base);
    expect(layoutKey(request(["a", "b"]))).not.toBe(base);
    expect(
      layoutKey({
        ...request(["a", "b"], [["a", "b"]]),
        nodes: [
          { id: "a", size: 14, parent: "dir:x" },
          { id: "b", size: 14 },
        ],
      }),
    ).not.toBe(base);
    expect(
      layoutKey({
        ...request(["a", "b"], [["a", "b"]]),
        nodes: [
          { id: "a", size: 30 },
          { id: "b", size: 14 },
        ],
      }),
    ).not.toBe(base);
    expect(
      layoutKey({ ...request(["a", "b"], [["a", "b"]]), packed: true }),
    ).not.toBe(base);
  });
});

describe("LayoutCache", () => {
  it("drops the least recently used layout, never the first", () => {
    const cache = new LayoutCache(2);
    cache.set("start", response(0));
    cache.set("b", response(1));
    cache.get("b");
    cache.set("c", response(2));
    // Over the limit: "b" is the least recent apart from the pinned start.
    expect(cache.get("start")?.id).toBe(0);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")?.id).toBe(2);
    cache.set("d", response(3));
    expect(cache.get("start")?.id).toBe(0);
    expect(cache.get("c")).toBeUndefined();
    expect(cache.get("d")?.id).toBe(3);
  });

  it("replaces a layout stored again under the same key", () => {
    const cache = new LayoutCache();
    cache.set("k", response(1));
    cache.set("k", response(2));
    expect(cache.get("k")?.id).toBe(2);
  });
});
