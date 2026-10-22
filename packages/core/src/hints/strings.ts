import type { CandidatePair } from "../interfaces/services.js";
import { byPair } from "./cochange.js";

export interface SharedStringOptions {
  /** A string used by more nodes than this links nothing: it is too common to mean a relation. */
  readonly maxFiles: number;
}

/** At most this many shared strings are kept per pair, for evidence. */
const MAX_SHARED = 10;

/**
 * Shared-string candidates from each node's key-like strings
 * (FileFacts.strings): pairs of nodes that use the same rare string. Each
 * string adds its rarity, ln(N / df), to the pair's weight, where N is the
 * number of nodes and df how many use it. Pure.
 */
export function sharedStringCandidates(
  files: readonly {
    readonly id: string;
    readonly strings: readonly string[];
  }[],
  opts: SharedStringOptions,
): CandidatePair[] {
  const users = new Map<string, Set<string>>();
  const nodes = new Set<string>();
  for (const f of files) {
    nodes.add(f.id);
    for (const s of f.strings) {
      const set = users.get(s) ?? new Set<string>();
      set.add(f.id);
      users.set(s, set);
    }
  }
  const n = nodes.size;
  const pairs = new Map<
    string,
    { shared: [string, number][]; weight: number }
  >();
  for (const [s, ids] of users) {
    const df = ids.size;
    if (df < 2 || df > opts.maxFiles) continue;
    const idf = Math.log(n / df);
    if (idf <= 0) continue;
    const sorted = [...ids].sort();
    for (const a of sorted) {
      for (const b of sorted) {
        if (a === b) continue;
        const key = `${a}\u0000${b}`;
        const p = pairs.get(key) ?? { shared: [], weight: 0 };
        p.shared.push([s, df]);
        p.weight += idf;
        pairs.set(key, p);
      }
    }
  }
  const out: CandidatePair[] = [];
  for (const [key, p] of pairs) {
    const [source = "", target = ""] = key.split("\u0000");
    const shared = p.shared
      .sort(([s1, d1], [s2, d2]) => d1 - d2 || (s1 < s2 ? -1 : s1 > s2 ? 1 : 0))
      .slice(0, MAX_SHARED)
      .map(([s]) => s);
    out.push({
      source,
      target,
      signals: { strings: { shared, weight: p.weight } },
    });
  }
  return out.sort(byPair);
}
