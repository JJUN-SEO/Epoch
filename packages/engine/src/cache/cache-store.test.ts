import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { CacheStore, FileFacts, RepoIndex } from "@epoch-dev/core";
import { MemoryCacheStore } from "./memory-store.js";
import {
  CACHE_FILE,
  CACHE_SCHEMA_VERSION,
  NewerCacheError,
  SqliteCacheStore,
} from "./sqlite-store.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "epoch-cache-"));
  dirs.push(d);
  return d;
};
const opened: CacheStore[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const facts = (n: number): FileFacts => ({
  imports: [
    {
      kind: "static",
      specifier: `./m${String(n)}`,
      typeOnly: false,
      names: [{ imported: "x" }],
      line: 1,
    },
  ],
  exports: [{ name: `e${String(n)}` }],
  exportAllFrom: [],
  flagUsages: [],
  constantConditions: [],
  isGenerated: false,
  loc: n,
});

const index: RepoIndex = {
  root: "/repo",
  lastCommit: "abc",
  scanStartedNs: "1700000000000000000",
  files: [
    {
      path: "a.ts",
      size: 10,
      mtimeNs: "1699999999000000000",
      contentHash: "h1",
    },
    {
      path: "b.ts",
      size: 20,
      mtimeNs: "1699999999000000001",
      contentHash: "h2",
    },
  ],
};

const stores: [string, () => CacheStore][] = [
  ["memory", () => new MemoryCacheStore()],
  ["sqlite", () => SqliteCacheStore.open(tempDir())],
];

describe.each(stores)("CacheStore contract (%s)", (_name, make) => {
  const open = () => {
    const s = make();
    opened.push(s);
    return s;
  };

  it("round-trips facts and misses unknown keys", () => {
    const s = open();
    expect(s.getFacts("k1")).toBeUndefined();
    s.putFacts("k1", facts(1));
    expect(s.getFacts("k1")).toEqual(facts(1));
    s.putFacts("k1", facts(2));
    expect(s.getFacts("k1")).toEqual(facts(2));
  });

  it("replaces a repo's manifest wholesale", () => {
    const s = open();
    expect(s.getRepoIndex("/repo")).toBeUndefined();
    s.putRepoIndex(index);
    expect(s.getRepoIndex("/repo")).toEqual(index);
    const next = { ...index, lastCommit: null, files: index.files.slice(1) };
    s.putRepoIndex(next);
    expect(s.getRepoIndex("/repo")).toEqual(next);
    expect(s.stats().manifestEntries).toBe(1);
  });

  it("stores derived values by namespace and key", () => {
    const s = open();
    s.putDerived("score", "a.ts", "h", { p: 0.5 });
    expect(s.getDerived("score", "a.ts")).toEqual({
      inputHash: "h",
      value: { p: 0.5 },
    });
    expect(s.getDerived("summary", "a.ts")).toBeUndefined();
  });

  it("prunes least-recently-used entries first", () => {
    const s = open();
    for (let i = 0; i < 5; i++) s.putFacts(`k${String(i)}`, facts(i));
    s.getFacts("k0"); // k0 becomes the most recently used
    const one = JSON.stringify(facts(1)).length;
    expect(s.prune(one * 2 + 2)).toBe(3);
    expect(s.getFacts("k0")).toEqual(facts(0));
    expect(s.getFacts("k4")).toEqual(facts(4));
    expect(s.getFacts("k1")).toBeUndefined();
    expect(s.prune(Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it("clears everything", () => {
    const s = open();
    s.putFacts("k", facts(1));
    s.putRepoIndex(index);
    s.putDerived("n", "k", "h", 1);
    s.clear();
    expect(s.stats()).toMatchObject({
      facts: 0,
      repos: 0,
      manifestEntries: 0,
      derived: 0,
    });
  });
});

describe("SqliteCacheStore", () => {
  it("persists across reopen and uses WAL", () => {
    const dir = tempDir();
    const a = SqliteCacheStore.open(dir);
    a.putFacts("k", facts(3));
    a.putRepoIndex(index);
    a.close();
    const b = SqliteCacheStore.open(dir);
    opened.push(b);
    expect(b.getFacts("k")).toEqual(facts(3));
    expect(b.getRepoIndex("/repo")).toEqual(index);
    const db = new Database(path.join(dir, CACHE_FILE), { readonly: true });
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("user_version", { simple: true })).toBe(
      CACHE_SCHEMA_VERSION,
    );
    db.close();
  });

  it.skipIf(process.platform === "win32")("is owner-only on POSIX", () => {
    const dir = path.join(tempDir(), "nested", "epoch");
    const s = SqliteCacheStore.open(dir);
    opened.push(s);
    s.putFacts("k", facts(1));
    const mode = (p: string) => fs.statSync(p).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    for (const f of [CACHE_FILE, `${CACHE_FILE}-wal`, `${CACHE_FILE}-shm`]) {
      expect(mode(path.join(dir, f)), f).toBe(0o600);
    }
  });

  it("moves an unreadable database aside and starts over", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, CACHE_FILE),
      "this is not a database, just text that is long enough",
    );
    const s = SqliteCacheStore.open(dir);
    opened.push(s);
    expect(s.stats().facts).toBe(0);
    s.putFacts("k", facts(1));
    expect(s.getFacts("k")).toEqual(facts(1));
    expect(
      fs.readdirSync(dir).some((f) => f.startsWith(`${CACHE_FILE}.corrupt-`)),
    ).toBe(true);
  });

  it("refuses a database written by a newer Epoch instead of destroying it", () => {
    const dir = tempDir();
    SqliteCacheStore.open(dir).close();
    const db = new Database(path.join(dir, CACHE_FILE));
    db.pragma(`user_version = ${String(CACHE_SCHEMA_VERSION + 1)}`);
    db.close();
    expect(() => SqliteCacheStore.open(dir)).toThrow(NewerCacheError);
    expect(fs.readdirSync(dir).some((f) => f.includes("corrupt"))).toBe(false);
  });

  it("treats a stored value that no longer validates as a miss and drops it", () => {
    const dir = tempDir();
    const s = SqliteCacheStore.open(dir);
    opened.push(s);
    s.putFacts("k", facts(1));
    const db = new Database(path.join(dir, CACHE_FILE));
    db.prepare("UPDATE facts SET value = ? WHERE key = 'k'").run(
      '{"imports":"nope"}',
    );
    db.close();
    expect(s.getFacts("k")).toBeUndefined();
    expect(s.stats().facts).toBe(0);
  });

  it("lets two connections (CLI and app) write at the same time", () => {
    const dir = tempDir();
    const a = SqliteCacheStore.open(dir);
    const b = SqliteCacheStore.open(dir);
    opened.push(a, b);
    a.transaction(() => {
      for (let i = 0; i < 50; i++) a.putFacts(`a${String(i)}`, facts(i));
    });
    b.transaction(() => {
      for (let i = 0; i < 50; i++) b.putFacts(`b${String(i)}`, facts(i));
    });
    expect(a.getFacts("b49")).toEqual(facts(49));
    expect(b.getFacts("a49")).toEqual(facts(49));
    expect(a.stats().facts).toBe(100);
  });
});
