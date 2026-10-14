import {
  CachedFacts,
  type CacheStats,
  type CacheStore,
  type RepoIndex,
} from "@epoch-dev/core";

interface Row {
  json: string;
  lastUsed: number;
}

/**
 * An in-memory CacheStore for tests (CLAUDE.md "Local cache"). Values are kept
 * as JSON, as the SQLite store keeps them, so tests see the same validation.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly facts = new Map<string, Row>();
  private readonly derived = new Map<string, Row & { inputHash: string }>();
  private readonly repos = new Map<string, RepoIndex>();
  private clock = 0;

  getFacts(key: string): CachedFacts | undefined {
    const row = this.facts.get(key);
    if (!row) return undefined;
    const parsed = CachedFacts.safeParse(JSON.parse(row.json));
    if (!parsed.success) {
      this.facts.delete(key);
      return undefined;
    }
    row.lastUsed = ++this.clock;
    return parsed.data;
  }

  putFacts(key: string, facts: CachedFacts): void {
    this.facts.set(key, {
      json: JSON.stringify(facts),
      lastUsed: ++this.clock,
    });
  }

  getRepoIndex(root: string): RepoIndex | undefined {
    const index = this.repos.get(root);
    return index && structuredClone(index);
  }

  putRepoIndex(index: RepoIndex): void {
    this.repos.set(index.root, structuredClone(index));
  }

  getDerived(
    namespace: string,
    key: string,
  ): { inputHash: string; value: unknown } | undefined {
    const row = this.derived.get(`${namespace}\u0000${key}`);
    if (!row) return undefined;
    row.lastUsed = ++this.clock;
    return { inputHash: row.inputHash, value: JSON.parse(row.json) as unknown };
  }

  putDerived(
    namespace: string,
    key: string,
    inputHash: string,
    value: unknown,
  ): void {
    this.derived.set(`${namespace}\u0000${key}`, {
      inputHash,
      json: JSON.stringify(value),
      lastUsed: ++this.clock,
    });
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }

  stats(): CacheStats {
    let bytes = 0;
    for (const r of this.facts.values()) bytes += r.json.length;
    for (const r of this.derived.values()) bytes += r.json.length;
    let manifestEntries = 0;
    for (const r of this.repos.values()) manifestEntries += r.files.length;
    return {
      bytes,
      facts: this.facts.size,
      repos: this.repos.size,
      manifestEntries,
      derived: this.derived.size,
    };
  }

  clear(): void {
    this.facts.clear();
    this.derived.clear();
    this.repos.clear();
  }

  prune(maxBytes: number): number {
    const rows = [
      ...[...this.facts].map(([k, r]) => ({
        map: this.facts,
        k,
        r,
      })),
      ...[...this.derived].map(([k, r]) => ({
        map: this.derived,
        k,
        r,
      })),
    ].sort((a, b) => a.r.lastUsed - b.r.lastUsed);
    let bytes = rows.reduce((n, x) => n + x.r.json.length, 0);
    let removed = 0;
    for (const { map, k, r } of rows) {
      if (bytes <= maxBytes) break;
      map.delete(k);
      bytes -= r.json.length;
      removed++;
    }
    return removed;
  }

  close(): void {
    // nothing to release
  }
}
