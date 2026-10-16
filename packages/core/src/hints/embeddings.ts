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

/** Cosine of two unit vectors, rounded so the graph does not depend on float noise. */
function cosineOf(a: Float32Array, b: Float32Array): number {
  let c = 0;
  for (let d = 0; d < a.length; d++) c += (a[d] ?? 0) * (b[d] ?? 0);
  return Math.round(c * 1e4) / 1e4;
}

/**
 * One unit vector per node: a node with several files (a Go package) is the
 * mean of its files' normalized vectors. Files without a direction, or of
 * another length than the node's first file, are skipped. Pure.
 */
export function nodeVectors(
  files: readonly { readonly id: string; readonly vector: Float32Array }[],
): Map<string, Float32Array> {
  const sums = new Map<string, Float32Array>();
  for (const f of files) {
    const v = normalized(f.vector);
    if (!v) continue;
    const sum = sums.get(f.id);
    if (!sum) {
      sums.set(f.id, Float32Array.from(v));
    } else if (sum.length === v.length) {
      for (let i = 0; i < v.length; i++) sum[i] = (sum[i] ?? 0) + (v[i] ?? 0);
    }
  }
  const out = new Map<string, Float32Array>();
  for (const [id, sum] of [...sums].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const v = normalized(sum);
    if (v) out.set(id, v);
  }
  return out;
}

/**
 * Embedding candidates (ADR-008): each node's k nearest neighbors by cosine
 * similarity, brute force over the nodes' vectors, never all pairs as
 * candidates. Similarity is symmetric, so a pair found from either side is
 * proposed in both directions. Pure.
 */
export function embeddingCandidates(
  vectors: ReadonlyMap<string, Float32Array>,
  opts: EmbeddingCandidateOptions,
): CandidatePair[] {
  const nodes = [...vectors];
  const cosine = new Map<string, number>();
  for (const [i, [aId, a]] of nodes.entries()) {
    const near: { j: number; c: number }[] = [];
    for (const [j, [, b]] of nodes.entries()) {
      if (i === j || a.length !== b.length) continue;
      const c = cosineOf(a, b);
      if (c >= opts.minCosine) near.push({ j, c });
    }
    near.sort((x, y) => y.c - x.c || x.j - y.j);
    for (const { j, c } of near.slice(0, opts.k)) {
      const bId = nodes[j]?.[0];
      if (bId === undefined) continue;
      cosine.set(`${aId}\u0000${bId}`, c);
      cosine.set(`${bId}\u0000${aId}`, c);
    }
  }
  const out: CandidatePair[] = [];
  for (const [key, c] of cosine) {
    const [source = "", target = ""] = key.split("\u0000");
    out.push({ source, target, signals: { embedding: { cosine: c } } });
  }
  return out.sort(byPair);
}

/**
 * Every candidate's embedding cosine, where both nodes have a vector: with
 * a model present, the similarity of a co-change or shared-string pair is
 * known too, so "no signal" is never mistaken for "similarity 0". Pure.
 */
export function withCosine(
  candidates: readonly CandidatePair[],
  vectors: ReadonlyMap<string, Float32Array>,
): CandidatePair[] {
  return candidates.map((c) => {
    if (c.signals.embedding) return c;
    const a = vectors.get(c.source);
    const b = vectors.get(c.target);
    if (!a || a.length !== b?.length) return c;
    return {
      ...c,
      signals: { ...c.signals, embedding: { cosine: cosineOf(a, b) } },
    };
  });
}
