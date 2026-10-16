import type { CandidatePair } from "../interfaces/services.js";
import { byPair } from "./cochange.js";

export interface EmbeddingCandidateOptions {
  /** Each node proposes its k most similar nodes. */
  readonly k: number;
  /** Pairs less similar than this propose nothing. */
  readonly minCosine: number;
}

function normalized(v: Float32Array): Float32Array | undefined {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return undefined;
  return v.map((x) => x / norm);
}

/**
 * Embedding candidates (ADR-008): each node's k nearest neighbors by cosine
 * similarity, brute force over the nodes' vectors, never all pairs as
 * candidates. A node with several files (a Go package) is the mean of its
 * files' normalized vectors. Similarity is symmetric, so a pair found from
 * either side is proposed in both directions. Pure.
 */
export function embeddingCandidates(
  files: readonly { readonly id: string; readonly vector: Float32Array }[],
  opts: EmbeddingCandidateOptions,
): CandidatePair[] {
  const sums = new Map<string, { sum: Float32Array; n: number }>();
  for (const f of files) {
    const v = normalized(f.vector);
    if (!v) continue;
    const acc = sums.get(f.id);
    if (!acc) {
      sums.set(f.id, { sum: Float32Array.from(v), n: 1 });
    } else if (acc.sum.length === v.length) {
      for (let i = 0; i < v.length; i++)
        acc.sum[i] = (acc.sum[i] ?? 0) + (v[i] ?? 0);
      acc.n++;
    }
  }
  const nodes: { id: string; v: Float32Array }[] = [];
  for (const [id, { sum }] of [...sums].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const v = normalized(sum);
    if (v) nodes.push({ id, v });
  }
  const cosine = new Map<string, number>();
  for (const [i, a] of nodes.entries()) {
    const near: { j: number; c: number }[] = [];
    for (const [j, b] of nodes.entries()) {
      if (i === j || a.v.length !== b.v.length) continue;
      let c = 0;
      for (let d = 0; d < a.v.length; d++) c += (a.v[d] ?? 0) * (b.v[d] ?? 0);
      if (c >= opts.minCosine) near.push({ j, c });
    }
    near.sort((x, y) => y.c - x.c || x.j - y.j);
    for (const { j, c } of near.slice(0, opts.k)) {
      const b = nodes[j];
      if (!b) continue;
      // Rounded so the canonical graph does not depend on float noise.
      const rounded = Math.round(c * 1e4) / 1e4;
      cosine.set(`${a.id}\u0000${b.id}`, rounded);
      cosine.set(`${b.id}\u0000${a.id}`, rounded);
    }
  }
  const out: CandidatePair[] = [];
  for (const [key, c] of cosine) {
    const [source = "", target = ""] = key.split("\u0000");
    out.push({ source, target, signals: { embedding: { cosine: c } } });
  }
  return out.sort(byPair);
}
