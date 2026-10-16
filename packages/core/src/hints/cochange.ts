import type { CandidatePair } from "../interfaces/services.js";

export interface CochangeOptions {
  /** Commits that change more files than this (bulk renames, formatting) are skipped. */
  readonly maxFiles: number;
  /** A pair needs at least this many commits together. */
  readonly minSupport: number;
}

const pairKey = (a: string, b: string) => `${a}\u0000${b}`;

/**
 * Co-change candidates from commit file sets (node ids, already lifted to
 * packages where needed): for every pair changed together in at least
 * `minSupport` commits, one candidate per direction, with how often each
 * changed. Pure; the engine reads the commits from git.
 */
export function cochangeCandidates(
  commits: readonly (readonly string[])[],
  opts: CochangeOptions,
): CandidatePair[] {
  const changed = new Map<string, number>();
  const together = new Map<string, number>();
  for (const commit of commits) {
    const files = [...new Set(commit)].sort();
    if (files.length === 0 || files.length > opts.maxFiles) continue;
    for (const f of files) changed.set(f, (changed.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = pairKey(files[i] ?? "", files[j] ?? "");
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }
  const out: CandidatePair[] = [];
  for (const [key, n] of together) {
    if (n < opts.minSupport) continue;
    const [a = "", b = ""] = key.split("\u0000");
    const na = changed.get(a) ?? 0;
    const nb = changed.get(b) ?? 0;
    out.push(
      {
        source: a,
        target: b,
        signals: {
          cochange: { together: n, sourceCommits: na, targetCommits: nb },
        },
      },
      {
        source: b,
        target: a,
        signals: {
          cochange: { together: n, sourceCommits: nb, targetCommits: na },
        },
      },
    );
  }
  return out.sort(byPair);
}

export const byPair = (a: CandidatePair, b: CandidatePair): number =>
  a.source < b.source
    ? -1
    : a.source > b.source
      ? 1
      : a.target < b.target
        ? -1
        : a.target > b.target
          ? 1
          : 0;
