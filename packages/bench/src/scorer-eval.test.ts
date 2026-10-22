import { describe, expect, it } from "vitest";
import type { CandidatePair } from "@epoch-dev/core";
import {
  brier,
  expectedCalibrationError,
  fitLogistic,
  forwardCommits,
  labelCandidates,
  precisionRecall,
  reliability,
  rocAuc,
  sigmoid,
} from "./scorer-eval.js";

/** `git log --reverse -z --name-status -M --format=%x01%H` output. */
const log = (...commits: string[][]) =>
  commits
    .map(
      (tokens, i) =>
        `\u0001c${String(i)}\n\u0000${tokens.join("\u0000")}\u0000`,
    )
    .join("");

describe("forwardCommits", () => {
  it("names each file as it was at the start of the window, following renames forward", () => {
    const out = forwardCommits(
      log(
        ["M", "a.ts", "M", "b.ts"],
        ["R100", "a.ts", "lib/a.ts"],
        ["M", "lib/a.ts", "A", "new.ts"],
        ["R090", "lib/a.ts", "src/a.ts", "D", "b.ts"],
        ["M", "src/a.ts", "C100", "b.ts", "copy.ts"],
      ),
    );
    expect(out).toEqual([
      ["a.ts", "b.ts"],
      ["a.ts"],
      ["a.ts", "new.ts"],
      ["a.ts", "b.ts"],
      ["a.ts", "copy.ts"],
    ]);
  });
});

const pair = (
  source: string,
  target: string,
  signals: CandidatePair["signals"] = {},
): CandidatePair => ({ source, target, signals });

describe("labelCandidates", () => {
  it("labels a pair by whether a later commit that changed the target also changed the source", () => {
    const commits = [["a", "b"], ["b"], ["c", "d"]];
    const r = labelCandidates(
      [pair("a", "b"), pair("b", "a"), pair("a", "c"), pair("c", "e")],
      commits,
    );
    expect(
      r.labeled.map((l) => [l.candidate.source, l.candidate.target, l.y]),
    ).toEqual([
      ["a", "b", 1],
      ["b", "a", 1],
      ["a", "c", 0],
    ]);
    // e never changes: no evidence either way.
    expect(r.excluded).toBe(1);
    // Directed pairs that changed together later: a-b, b-a, c-d, d-c.
    expect(r.positivePairs).toBe(4);
    expect(r.candidatePositives).toBe(2);
  });
});

describe("fitLogistic", () => {
  it("recovers the coefficients of data drawn from a logistic model", () => {
    // Deterministic data on a grid: p(y=1 | x) = sigmoid(-1 + 2x).
    const xs: number[][] = [];
    const ys: number[] = [];
    const ws: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const x = i / 10;
      const p = sigmoid(-1 + 2 * x);
      // Each grid point stands for 1000 examples, split by p.
      xs.push([1, x], [1, x]);
      ys.push(1, 0);
      ws.push(1000 * p, 1000 * (1 - p));
    }
    const beta = fitLogistic(xs, ys, ws, { l2: 1e-6 });
    expect(beta[0]).toBeCloseTo(-1, 3);
    expect(beta[1]).toBeCloseTo(2, 3);
  });

  it("leaves a feature that never varies at zero instead of failing", () => {
    const beta = fitLogistic(
      [
        [1, 1, 0],
        [1, 0, 0],
        [1, 1, 0],
        [1, 0, 0],
      ],
      [1, 0, 0, 1],
      [1, 1, 1, 1],
      { l2: 1 },
    );
    expect(beta[2]).toBe(0);
    expect(beta.every(Number.isFinite)).toBe(true);
  });
});

describe("calibration metrics", () => {
  const ps = [0.1, 0.1, 0.9, 0.9, 0.5];
  const ys = [0, 0, 1, 0, 1];

  it("computes the Brier score and the expected calibration error", () => {
    expect(brier(ps, ys)).toBeCloseTo(
      (0.01 + 0.01 + 0.01 + 0.81 + 0.25) / 5,
      10,
    );
    // Bins of width 0.1: [0.1,0.2) has p 0.1, rate 0; [0.5,0.6) p 0.5, rate
    // 1; [0.9,1] p 0.9, rate 0.5. ECE = (2*0.1 + 1*0.5 + 2*0.4) / 5.
    expect(expectedCalibrationError(ps, ys, 10)).toBeCloseTo(
      (2 * 0.1 + 0.5 + 2 * 0.4) / 5,
      10,
    );
    expect(reliability(ps, ys, 10).filter((b) => b.n > 0)).toEqual([
      { lo: 0.1, hi: 0.2, n: 2, meanP: 0.1, rate: 0 },
      { lo: 0.5, hi: 0.6, n: 1, meanP: 0.5, rate: 1 },
      { lo: 0.9, hi: 1, n: 2, meanP: 0.9, rate: 0.5 },
    ]);
  });

  it("ranks with ROC AUC, ties counting half", () => {
    expect(rocAuc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
    expect(rocAuc([0.9, 0.8, 0.2, 0.1], [0, 0, 1, 1])).toBe(0);
    expect(rocAuc([0.5, 0.5], [0, 1])).toBe(0.5);
    expect(rocAuc([0.5, 0.5], [1, 1])).toBeNaN();
  });

  it("gives precision and recall at each threshold", () => {
    expect(precisionRecall(ps, ys, [0.5, 0.95])).toEqual([
      { threshold: 0.5, predicted: 3, precision: 2 / 3, recall: 1 },
      { threshold: 0.95, predicted: 0, precision: Number.NaN, recall: 0 },
    ]);
  });
});
