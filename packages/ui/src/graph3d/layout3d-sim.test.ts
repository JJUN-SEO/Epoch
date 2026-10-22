import { describe, expect, it } from "vitest";
import { simulate3d } from "./layout3d-sim";

/** A ring of `n` files in two folders. */
function ring(n: number) {
  const links = new Int32Array(n * 2);
  for (let i = 0; i < n; i++) {
    links[2 * i] = i;
    links[2 * i + 1] = (i + 1) % n;
  }
  const groups = Int32Array.from({ length: n }, (_, i) => i % 2);
  return { count: n, groups, links };
}

/** A clock that moves 10 ms per reading. */
function clock() {
  let t = 0;
  return () => (t += 10);
}

describe("simulate3d", () => {
  it("shows the starting positions at once, then streams by time, then finishes", () => {
    const frames: { positions: Float32Array; done: boolean }[] = [];
    const ticks = simulate3d(
      ring(40),
      (positions, done) => frames.push({ positions, done }),
      { now: clock(), frameMs: 100 },
    );
    expect(frames.length).toBeGreaterThan(2);
    // The first frame comes before any tick: the starting spiral, not zeros.
    expect(frames[0]?.done).toBe(false);
    expect(frames[0]?.positions.some((v) => v !== 0)).toBe(true);
    // One intermediate frame per 100 ms of (fake) time, about every 10 ticks.
    expect(frames.length).toBeLessThanOrEqual(2 + Math.ceil(ticks / 9));
    expect(frames.at(-1)?.done).toBe(true);
    expect(frames.filter((f) => f.done)).toHaveLength(1);
  });

  it("starts from given positions, and settles in fewer steps", () => {
    const input = ring(40);
    let settled: Float32Array | undefined;
    const cold = simulate3d(
      input,
      (positions, done) => {
        if (done) settled = positions;
      },
      { now: clock(), frameMs: 100 },
    );
    if (!settled) throw new Error("no final frame");
    const start = settled.slice();
    let first: Float32Array | undefined;
    let last: Float32Array | undefined;
    const warm = simulate3d(
      { ...input, initial: start },
      (positions, done) => {
        first ??= positions;
        if (done) last = positions;
      },
      { now: clock(), frameMs: 100 },
    );
    expect(warm).toBeLessThan(cold);
    expect([...(first ?? [])]).toEqual([...start]);
    // Already settled: the warm run only nudges files (it finishes cooling),
    // far less than the size of the layout; nothing is reshuffled.
    let moved = 0;
    let extent = 0;
    for (let i = 0; i < start.length; i++) {
      moved = Math.max(moved, Math.abs((last?.[i] ?? 0) - (start[i] ?? 0)));
      extent = Math.max(extent, Math.abs(start[i] ?? 0));
    }
    expect(moved).toBeLessThan(extent * 0.25);
  });

  it("ignores starting positions of the wrong size", () => {
    let first: Float32Array | undefined;
    simulate3d(
      { ...ring(10), initial: new Float32Array(3) },
      (positions) => {
        first ??= positions;
      },
      { now: clock(), frameMs: 100 },
    );
    expect(first?.length).toBe(30);
    expect(first?.some((v) => v !== 0)).toBe(true);
  });

  it("ignores starting positions that put every file in one place", () => {
    // A layout started that way blows apart: every file repels every other
    // from the same point (radius 6,542 instead of 605 on a 600-file graph).
    const input = ring(60);
    let cold: Float32Array | undefined;
    let stacked: Float32Array | undefined;
    simulate3d(
      input,
      (p, done) => {
        if (done) cold = p;
      },
      { now: clock(), frameMs: 100 },
    );
    simulate3d(
      { ...input, initial: new Float32Array(60 * 3).fill(4) },
      (p, done) => {
        if (done) stacked = p;
      },
      { now: clock(), frameMs: 100 },
    );
    expect([...(stacked ?? [])]).toEqual([...(cold ?? [])]);
  });
});
