import type { CandidatePair } from "@epoch-dev/core";

/*
 * The pure half of bench:scorers (ADR-008): labels for hint candidates from
 * later history, a weighted logistic fit, and calibration metrics. The
 * runner (scorers.ts) reads git and runs the engine; everything here is a
 * function of its inputs, so the evaluation protocol is unit-tested.
 */

const MARK = "\u0001";

/**
 * Parses `git log --reverse -z --name-status -M --format=%x01<header>`
 * (oldest first) into each commit's header (what followed the mark: a hash,
 * a subject) and files, named as they were at the start of the window: a
 * file renamed later keeps its old name, so changes after a rename still
 * count for the node it was. A copy's new file keeps its own name (it did
 * not exist before).
 */
export function forwardCommitLog(
  out: string,
): { header: string; files: string[] }[] {
  const original = new Map<string, string>();
  const nameAtStart = (p: string) => original.get(p) ?? p;
  const commits: { header: string; files: Set<string> }[] = [];
  let files: Set<string> | undefined;
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = (tokens[i] ?? "").replace(/^\n+/, "");
    if (token.startsWith(MARK)) {
      files = new Set();
      commits.push({ header: token.slice(MARK.length).trim(), files });
      continue;
    }
    const status = token.trim();
    if (status === "" || files === undefined) continue;
    if (status.startsWith("R")) {
      const from = tokens[++i] ?? "";
      const to = tokens[++i] ?? "";
      const name = nameAtStart(from);
      original.set(to, name);
      files.add(name);
    } else if (status.startsWith("C")) {
      i++; // the copied-from file did not change
      files.add(nameAtStart(tokens[++i] ?? ""));
    } else {
      files.add(nameAtStart(tokens[++i] ?? ""));
    }
  }
  return commits.map((c) => ({
    header: c.header,
    files: [...c.files].filter((f) => f !== "").sort(),
  }));
}

/** Each commit's files, as forwardCommitLog names them. */
export const forwardCommits = (out: string): string[][] =>
  forwardCommitLog(out).map((c) => c.files);

export interface Labeled {
  readonly candidate: CandidatePair;
  /** 1: a later commit that changed the target also changed the source. */
  readonly y: 0 | 1;
}

export interface Labels {
  readonly labeled: readonly Labeled[];
  /** Candidates whose target never changed later: no evidence either way. */
  readonly excluded: number;
  /** Directed pairs of nodes that changed together later (any, candidates or not). */
  readonly positivePairs: number;
  /** Of those, how many were candidates. */
  readonly candidatePositives: number;
}

/**
 * Labels candidates with later commits (node ids per commit, already
 * filtered by size). A candidate source -> target claims "when target
 * changes, source changes too", so it is judged only if target changed:
 * y = 1 when some commit changed both.
 */
export function labelCandidates(
  candidates: readonly CandidatePair[],
  commits: readonly (readonly string[])[],
): Labels {
  const changed = new Map<string, Set<number>>();
  const together = new Set<string>();
  for (const [i, commit] of commits.entries()) {
    const nodes = [...new Set(commit)];
    for (const n of nodes) {
      const set = changed.get(n) ?? new Set<number>();
      set.add(i);
      changed.set(n, set);
    }
    for (const a of nodes)
      for (const b of nodes) if (a !== b) together.add(`${a}\u0000${b}`);
  }
  const labeled: Labeled[] = [];
  let excluded = 0;
  let candidatePositives = 0;
  for (const c of candidates) {
    if (!changed.has(c.target)) {
      excluded++;
      continue;
    }
    const y = together.has(`${c.source}\u0000${c.target}`) ? 1 : 0;
    if (y === 1) candidatePositives++;
    labeled.push({ candidate: c, y });
  }
  return {
    labeled,
    excluded,
    positivePairs: together.size,
    candidatePositives,
  };
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Solves A x = b by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] ?? 0]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0))
        pivot = r;
    }
    const tmp = m[col];
    m[col] = m[pivot] ?? [];
    m[pivot] = tmp ?? [];
    const p = m[col]?.[col] ?? 0;
    if (p === 0) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = (m[r]?.[col] ?? 0) / p;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) {
        const row = m[r];
        if (row) row[c] = (row[c] ?? 0) - f * (m[col]?.[c] ?? 0);
      }
    }
  }
  return m.map((row, i) => {
    const p = row[i] ?? 0;
    return p === 0 ? 0 : (row[n] ?? 0) / p;
  });
}

/**
 * Weighted logistic regression by Newton's method, with an L2 penalty on
 * every coefficient but the first (the intercept; xs rows start with 1).
 * A feature that is always 0 stays at 0.
 */
export function fitLogistic(
  xs: readonly (readonly number[])[],
  ys: readonly number[],
  ws: readonly number[],
  opts: { readonly l2: number; readonly iterations?: number },
): number[] {
  const k = xs[0]?.length ?? 0;
  let beta = new Array<number>(k).fill(0);
  for (let iter = 0; iter < (opts.iterations ?? 100); iter++) {
    const grad = new Array<number>(k).fill(0);
    const hess = Array.from({ length: k }, () => new Array<number>(k).fill(0));
    for (const [i, x] of xs.entries()) {
      const w = ws[i] ?? 0;
      if (w === 0) continue;
      let z = 0;
      for (let j = 0; j < k; j++) z += (beta[j] ?? 0) * (x[j] ?? 0);
      const p = sigmoid(z);
      const r = (ys[i] ?? 0) - p;
      const v = p * (1 - p) * w;
      for (let j = 0; j < k; j++) {
        const xj = x[j] ?? 0;
        if (xj === 0) continue;
        grad[j] = (grad[j] ?? 0) + w * r * xj;
        const row = hess[j];
        if (!row) continue;
        for (let l = 0; l < k; l++)
          row[l] = (row[l] ?? 0) + v * xj * (x[l] ?? 0);
      }
    }
    for (let j = 1; j < k; j++) {
      grad[j] = (grad[j] ?? 0) - opts.l2 * (beta[j] ?? 0);
      const row = hess[j];
      if (row) row[j] = (row[j] ?? 0) + opts.l2;
    }
    const step = solve(hess, grad);
    beta = beta.map((b, j) => b + (step[j] ?? 0));
    if (step.every((s) => Math.abs(s) < 1e-10)) break;
  }
  return beta;
}

/** Mean squared error of probabilities against outcomes. */
export function brier(ps: readonly number[], ys: readonly number[]): number {
  let s = 0;
  for (const [i, p] of ps.entries()) s += (p - (ys[i] ?? 0)) ** 2;
  return ps.length === 0 ? Number.NaN : s / ps.length;
}

export interface Bin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanP: number;
  readonly rate: number;
}

/** Equal-width probability bins: how often each bin's predictions came true. */
export function reliability(
  ps: readonly number[],
  ys: readonly number[],
  bins: number,
): Bin[] {
  const acc = Array.from({ length: bins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const [i, p] of ps.entries()) {
    const b = acc[Math.min(bins - 1, Math.max(0, Math.floor(p * bins)))];
    if (!b) continue;
    b.n++;
    b.p += p;
    b.y += ys[i] ?? 0;
  }
  return acc.map((b, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: b.n,
    meanP: b.n === 0 ? Number.NaN : b.p / b.n,
    rate: b.n === 0 ? Number.NaN : b.y / b.n,
  }));
}

/** The bins' gaps between predicted and observed rates, weighted by size. */
export function expectedCalibrationError(
  ps: readonly number[],
  ys: readonly number[],
  bins: number,
): number {
  if (ps.length === 0) return Number.NaN;
  let s = 0;
  for (const b of reliability(ps, ys, bins)) {
    if (b.n > 0) s += b.n * Math.abs(b.meanP - b.rate);
  }
  return s / ps.length;
}

export interface PrPoint {
  readonly threshold: number;
  readonly predicted: number;
  readonly precision: number;
  readonly recall: number;
}

/** Precision and recall of "p >= threshold" over the labeled candidates. */
export function precisionRecall(
  ps: readonly number[],
  ys: readonly number[],
  thresholds: readonly number[],
): PrPoint[] {
  const positives = ys.filter((y) => y === 1).length;
  return thresholds.map((threshold) => {
    let predicted = 0;
    let hits = 0;
    for (const [i, p] of ps.entries()) {
      if (p < threshold) continue;
      predicted++;
      if (ys[i] === 1) hits++;
    }
    return {
      threshold,
      predicted,
      precision: predicted === 0 ? Number.NaN : hits / predicted,
      recall: positives === 0 ? Number.NaN : hits / positives,
    };
  });
}

/**
 * Area under the ROC curve: the chance that a random positive scores above
 * a random negative (ties count half). How well the scores rank, apart
 * from calibration.
 */
export function rocAuc(ps: readonly number[], ys: readonly number[]): number {
  const order = ps
    .map((p, i) => ({ p, y: ys[i] ?? 0 }))
    .sort((a, b) => a.p - b.p);
  let pos = 0;
  let neg = 0;
  let rankSum = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && order[j]?.p === order[i]?.p) j++;
    const midRank = (i + 1 + j) / 2; // ranks i+1..j, averaged over ties
    for (let k = i; k < j; k++) {
      if (order[k]?.y === 1) {
        pos++;
        rankSum += midRank;
      } else neg++;
    }
    i = j;
  }
  if (pos === 0 || neg === 0) return Number.NaN;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}
