import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { recomputeIfChanged, type DerivedStore } from "./early-cutoff.js";
import { resolveCacheDir } from "./location.js";

describe("resolveCacheDir", () => {
  const homedir = "/home/u";

  it("follows each OS's per-user cache convention", () => {
    expect(resolveCacheDir({ platform: "linux", env: {}, homedir })).toBe(
      "/home/u/.cache/epoch",
    );
    expect(
      resolveCacheDir({ platform: "darwin", env: {}, homedir: "/Users/u" }),
    ).toBe("/Users/u/Library/Caches/epoch");
    expect(
      resolveCacheDir({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
        homedir: "C:\\Users\\u",
      }),
    ).toBe("C:\\Users\\u\\AppData\\Local\\epoch\\Cache");
    expect(
      resolveCacheDir({ platform: "win32", env: {}, homedir: "C:\\Users\\u" }),
    ).toBe("C:\\Users\\u\\AppData\\Local\\epoch\\Cache");
  });

  it("honours an absolute XDG_CACHE_HOME and ignores a relative one", () => {
    expect(
      resolveCacheDir({
        platform: "linux",
        env: { XDG_CACHE_HOME: "/x/cache" },
        homedir,
      }),
    ).toBe("/x/cache/epoch");
    expect(
      resolveCacheDir({
        platform: "linux",
        env: { XDG_CACHE_HOME: "rel" },
        homedir,
      }),
    ).toBe("/home/u/.cache/epoch");
  });

  it("lets EPOCH_CACHE_DIR override everything", () => {
    expect(
      resolveCacheDir({
        platform: "darwin",
        env: { EPOCH_CACHE_DIR: "/tmp/c" },
        homedir,
      }),
    ).toBe("/tmp/c");
    expect(
      resolveCacheDir({
        platform: "linux",
        env: { EPOCH_CACHE_DIR: "" },
        homedir,
      }),
    ).toBe("/home/u/.cache/epoch");
  });
});

describe("canonicalJson", () => {
  it("is independent of key order at every level", () => {
    expect(
      canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }),
    ).toBe(canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("keeps array order", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("recomputeIfChanged (early cutoff)", () => {
  function memoryStore(): DerivedStore & { writes: number } {
    const rows = new Map<string, { inputHash: string; value: unknown }>();
    return {
      writes: 0,
      getDerived: (ns, key) => rows.get(`${ns}\u0000${key}`),
      putDerived(ns, key, inputHash, value) {
        this.writes++;
        rows.set(`${ns}\u0000${key}`, { inputHash, value });
      },
    };
  }
  const Num = z.number();
  const parseNum = (v: unknown) => Num.parse(v);

  it("computes once per distinct input and stops propagating when the input is unchanged", () => {
    const store = memoryStore();
    let calls = 0;
    const compute = () => ++calls * 10;
    expect(
      recomputeIfChanged(store, "score", "a.ts", "h1", compute, parseNum),
    ).toEqual({
      value: 10,
      recomputed: true,
    });
    expect(
      recomputeIfChanged(store, "score", "a.ts", "h1", compute, parseNum),
    ).toEqual({
      value: 10,
      recomputed: false,
    });
    expect(
      recomputeIfChanged(store, "score", "a.ts", "h2", compute, parseNum),
    ).toEqual({
      value: 20,
      recomputed: true,
    });
    expect(calls).toBe(2);
    expect(store.writes).toBe(2);
  });

  it("keeps namespaces and keys apart", () => {
    const store = memoryStore();
    recomputeIfChanged(store, "score", "a.ts", "h", () => 1, parseNum);
    expect(
      recomputeIfChanged(store, "summary", "a.ts", "h", () => 2, parseNum)
        .recomputed,
    ).toBe(true);
    expect(
      recomputeIfChanged(store, "score", "b.ts", "h", () => 3, parseNum)
        .recomputed,
    ).toBe(true);
  });

  it("recomputes when the stored value no longer validates", () => {
    const store = memoryStore();
    store.putDerived("score", "a.ts", "h", "not a number");
    expect(
      recomputeIfChanged(store, "score", "a.ts", "h", () => 5, parseNum),
    ).toEqual({
      value: 5,
      recomputed: true,
    });
  });
});
