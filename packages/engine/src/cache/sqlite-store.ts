import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  CachedFacts,
  SUMMARY_NAMESPACES,
  isSummaryNamespace,
  type CacheStats,
  type CacheStore,
  type ManifestEntry,
  type RepoIndex,
} from "@epoch-dev/core";

/** Bump with a new entry in MIGRATIONS whenever the schema changes. */
export const CACHE_SCHEMA_VERSION = 1;

/** Default cap on cached payload bytes; a default, not a measured choice (ADR-004). */
export const DEFAULT_MAX_CACHE_BYTES = 1024 * 1024 * 1024;

export const CACHE_FILE = "cache.sqlite";

/** MIGRATIONS[i] upgrades a database from user_version i to i + 1. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE facts (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    last_used INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX facts_lru ON facts (last_used);
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    last_commit TEXT,
    scan_started_ns TEXT NOT NULL,
    analyzed_at INTEGER NOT NULL
  );
  CREATE TABLE manifest (
    repo_id INTEGER NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ns TEXT NOT NULL,
    ctime_ns TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (repo_id, path)
  ) WITHOUT ROWID;
  CREATE TABLE derived (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    value TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    last_used INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  ) WITHOUT ROWID;
  CREATE INDEX derived_lru ON derived (last_used);
  `,
];

/** The database was written by a newer Epoch; using it could corrupt that version's data. */
export class NewerCacheError extends Error {
  readonly found: number;
  constructor(found: number) {
    super(
      `the cache was created by a newer Epoch (schema ${String(found)}, this build knows ${String(CACHE_SCHEMA_VERSION)}); set EPOCH_CACHE_DIR to use a separate cache`,
    );
    this.found = found;
  }
}

const POSIX = process.platform !== "win32";

/** Creates the directory owner-only (0700) and makes sure the database file is 0600. */
function prepareLocation(dir: string, file: string): void {
  const created = fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (POSIX && created !== undefined) fs.chmodSync(dir, 0o700);
  // Create the file with owner-only permissions before SQLite opens it; SQLite
  // gives the -wal and -shm files the same permissions as the database.
  fs.closeSync(fs.openSync(file, "a", 0o600));
  if (POSIX) fs.chmodSync(file, 0o600);
}

function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    const version = db.pragma("user_version", { simple: true });
    if (typeof version !== "number") throw new Error("unreadable user_version");
    if (version > CACHE_SCHEMA_VERSION) throw new NewerCacheError(version);
    for (let v = version; v < CACHE_SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined)
        throw new Error(`missing cache migration ${String(v)}`);
      db.transaction(() => {
        db.exec(sql);
        db.pragma(`user_version = ${String(v + 1)}`);
      })();
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/**
 * The SQLite CacheStore (ADR-004): WAL mode so the CLI and the app can share it,
 * schema migrations, owner-only permissions. Holds FileFacts, per-repo
 * manifests and derived values only; never file contents. The cache is derived
 * data: a database SQLite cannot read is moved aside and rebuilt.
 */
export class SqliteCacheStore implements CacheStore {
  private readonly db: Database.Database;
  readonly file: string;

  /** LRU clock: wall time in µs, forced strictly increasing within a connection. */
  private clock = 0;

  private constructor(db: Database.Database, file: string) {
    this.db = db;
    this.file = file;
  }

  private tick(): number {
    this.clock = Math.max(this.clock + 1, Date.now() * 1000);
    return this.clock;
  }

  static open(dir: string): SqliteCacheStore {
    const file = path.join(dir, CACHE_FILE);
    prepareLocation(dir, file);
    let db: Database.Database;
    try {
      db = openDatabase(file);
    } catch (err) {
      if (err instanceof NewerCacheError) throw err;
      // Not a database, or damaged: keep it for inspection and start over.
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(file + suffix)) {
          fs.renameSync(
            file + suffix,
            `${file}.corrupt-${String(Date.now())}${suffix}`,
          );
        }
      }
      prepareLocation(dir, file);
      db = openDatabase(file);
    }
    return new SqliteCacheStore(db, file);
  }

  getFacts(key: string): CachedFacts | undefined {
    const row = this.db
      .prepare<[string], { value: string }>(
        "SELECT value FROM facts WHERE key = ?",
      )
      .get(key);
    if (!row) return undefined;
    let parsed: ReturnType<typeof CachedFacts.safeParse>;
    try {
      parsed = CachedFacts.safeParse(JSON.parse(row.value));
    } catch {
      parsed = CachedFacts.safeParse(undefined);
    }
    if (!parsed.success) {
      this.db.prepare("DELETE FROM facts WHERE key = ?").run(key);
      return undefined;
    }
    this.db
      .prepare("UPDATE facts SET last_used = ? WHERE key = ?")
      .run(this.tick(), key);
    return parsed.data;
  }

  putFacts(key: string, cached: CachedFacts): void {
    const value = JSON.stringify(cached);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO facts (key, value, bytes, last_used) VALUES (?, ?, ?, ?)",
      )
      .run(key, value, Buffer.byteLength(value), this.tick());
  }

  getRepoIndex(root: string): RepoIndex | undefined {
    const repo = this.db
      .prepare<
        [string],
        { id: number; last_commit: string | null; scan_started_ns: string }
      >("SELECT id, last_commit, scan_started_ns FROM repos WHERE root = ?")
      .get(root);
    if (!repo) return undefined;
    const files = this.db
      .prepare<
        [number],
        {
          path: string;
          size: number;
          mtime_ns: string;
          ctime_ns: string;
          content_hash: string;
        }
      >(
        "SELECT path, size, mtime_ns, ctime_ns, content_hash FROM manifest WHERE repo_id = ? ORDER BY path",
      )
      .all(repo.id)
      .map((r): ManifestEntry => ({
        path: r.path,
        size: r.size,
        mtimeNs: r.mtime_ns,
        ctimeNs: r.ctime_ns,
        contentHash: r.content_hash,
      }));
    return {
      root,
      lastCommit: repo.last_commit,
      scanStartedNs: repo.scan_started_ns,
      files,
    };
  }

  putRepoIndex(index: RepoIndex): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO repos (root, last_commit, scan_started_ns, analyzed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (root) DO UPDATE SET last_commit = excluded.last_commit,
             scan_started_ns = excluded.scan_started_ns, analyzed_at = excluded.analyzed_at`,
        )
        .run(index.root, index.lastCommit, index.scanStartedNs, Date.now());
      const repo = this.db
        .prepare<[string], { id: number }>(
          "SELECT id FROM repos WHERE root = ?",
        )
        .get(index.root);
      if (!repo) throw new Error("repo row missing after upsert");
      this.db.prepare("DELETE FROM manifest WHERE repo_id = ?").run(repo.id);
      const insert = this.db.prepare(
        "INSERT INTO manifest (repo_id, path, size, mtime_ns, ctime_ns, content_hash) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const f of index.files) {
        insert.run(
          repo.id,
          f.path,
          f.size,
          f.mtimeNs,
          f.ctimeNs,
          f.contentHash,
        );
      }
    });
  }

  getDerived(
    namespace: string,
    key: string,
  ): { inputHash: string; value: unknown } | undefined {
    const row = this.db
      .prepare<[string, string], { input_hash: string; value: string }>(
        "SELECT input_hash, value FROM derived WHERE namespace = ? AND key = ?",
      )
      .get(namespace, key);
    if (!row) return undefined;
    this.db
      .prepare(
        "UPDATE derived SET last_used = ? WHERE namespace = ? AND key = ?",
      )
      .run(this.tick(), namespace, key);
    try {
      return {
        inputHash: row.input_hash,
        value: JSON.parse(row.value) as unknown,
      };
    } catch {
      return undefined;
    }
  }

  putDerived(
    namespace: string,
    key: string,
    inputHash: string,
    value: unknown,
  ): void {
    const json = JSON.stringify(value);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO derived (namespace, key, input_hash, value, bytes, last_used) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        namespace,
        key,
        inputHash,
        json,
        Buffer.byteLength(json),
        this.tick(),
      );
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  private payloadBytes(): number {
    const row = this.db
      .prepare<[], { n: number }>(
        "SELECT (SELECT COALESCE(SUM(bytes), 0) FROM facts) + (SELECT COALESCE(SUM(bytes), 0) FROM derived) AS n",
      )
      .get();
    return row?.n ?? 0;
  }

  stats(): CacheStats {
    const count = (table: string) =>
      this.db
        .prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)
        .get()?.n ?? 0;
    let bytes = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        bytes += fs.statSync(this.file + suffix).size;
      } catch {
        // file not present
      }
    }
    return {
      location: this.file,
      bytes,
      facts: count("facts"),
      repos: count("repos"),
      manifestEntries: count("manifest"),
      derived: count("derived"),
      summaries: {
        paid:
          this.countNamespace(SUMMARY_NAMESPACES.anthropic) +
          this.countNamespace(SUMMARY_NAMESPACES.openai) +
          this.countNamespace(SUMMARY_NAMESPACES.gemini),
        local: this.countNamespace(SUMMARY_NAMESPACES.local),
      },
    };
  }

  private countNamespace(namespace: string): number {
    return (
      this.db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM derived WHERE namespace = ?",
        )
        .get(namespace)?.n ?? 0
    );
  }

  clear(): void {
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM manifest; DELETE FROM repos; DELETE FROM facts; DELETE FROM derived;",
      );
    });
    this.db.exec("VACUUM");
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  /**
   * Evicts least-recently-used facts and derived values until their payload
   * fits in maxBytes; summaries last, as a paid one costs money to make again.
   */
  prune(maxBytes: number): number {
    return this.transaction(() => {
      let excess = this.payloadBytes() - maxBytes;
      if (excess <= 0) return 0;
      const rows = this.db
        .prepare<
          [],
          { tbl: string; k1: string; k2: string | null; bytes: number }
        >(
          `SELECT 'facts' AS tbl, key AS k1, NULL AS k2, bytes, last_used FROM facts
           UNION ALL
           SELECT 'derived', namespace, key, bytes, last_used FROM derived
           ORDER BY last_used, tbl, k1, k2`,
        )
        .all()
        .sort(
          (a, b) =>
            Number(a.tbl === "derived" && isSummaryNamespace(a.k1)) -
            Number(b.tbl === "derived" && isSummaryNamespace(b.k1)),
        );
      const delFact = this.db.prepare("DELETE FROM facts WHERE key = ?");
      const delDerived = this.db.prepare(
        "DELETE FROM derived WHERE namespace = ? AND key = ?",
      );
      let removed = 0;
      for (const r of rows) {
        if (excess <= 0) break;
        if (r.tbl === "facts") delFact.run(r.k1);
        else delDerived.run(r.k1, r.k2);
        excess -= r.bytes;
        removed++;
      }
      return removed;
    });
  }

  close(): void {
    this.db.close();
  }
}
