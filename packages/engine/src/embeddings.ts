import type { DerivedStore, Embedder } from "@epoch-dev/core";

/*
 * File embeddings for similarity candidates (M6, ADR-008). The text
 * embedded is the file's path and the start of its source, read through the
 * root-confined reader. Vectors are cached by path, content hash and model
 * (CLAUDE.md "Local cache": embeddings are cached; they are derived numbers,
 * never source), so a re-run embeds only changed files.
 */

const NAMESPACE = "embedding";
const BATCH = 32;

const isVector = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((x) => typeof x === "number");

/** One vector per readable file, from the cache where the content and model are unchanged. */
export async function embedFiles(
  files: readonly { readonly path: string; readonly contentHash: string }[],
  embedder: Embedder,
  opts: {
    readonly read: (path: string) => string | undefined;
    readonly maxChars: number;
    readonly store?: DerivedStore;
  },
): Promise<{ path: string; vector: Float32Array }[]> {
  const inputHash = `${embedder.modelId}\u0000${String(opts.maxChars)}`;
  const out = new Map<string, Float32Array>();
  const misses: { path: string; key: string; text: string }[] = [];
  for (const f of files) {
    const key = `${f.path}\u0000${f.contentHash}`;
    const hit = opts.store?.getDerived(NAMESPACE, key);
    if (hit?.inputHash === inputHash && isVector(hit.value)) {
      out.set(f.path, Float32Array.from(hit.value));
      continue;
    }
    const source = opts.read(f.path);
    if (source === undefined) continue;
    misses.push({
      path: f.path,
      key,
      text: `${f.path}\n${source.slice(0, opts.maxChars)}`,
    });
  }
  for (let i = 0; i < misses.length; i += BATCH) {
    const batch = misses.slice(i, i + BATCH);
    const vectors = await embedder.embed(batch.map((m) => m.text));
    if (vectors.length !== batch.length) {
      throw new Error(
        `the embedding model returned ${String(vectors.length)} vectors for ${String(batch.length)} texts`,
      );
    }
    for (const [j, m] of batch.entries()) {
      const v = vectors[j];
      if (!v) continue;
      out.set(m.path, v);
      opts.store?.putDerived(NAMESPACE, m.key, inputHash, Array.from(v));
    }
  }
  return files.flatMap((f) => {
    const vector = out.get(f.path);
    return vector ? [{ path: f.path, vector }] : [];
  });
}
