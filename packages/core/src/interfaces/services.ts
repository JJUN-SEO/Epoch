import type { DerivedStore } from "../cache/early-cutoff.js";
import type { CachedFacts } from "../schemas/index.js";

/** One file in a repo's manifest: what it looked like when it was last hashed. */
export interface ManifestEntry {
  /** Repo-relative path, forward slashes. */
  readonly path: string;
  readonly size: number;
  /** Modification time in nanoseconds, as a decimal string (exceeds 2^53). */
  readonly mtimeNs: string;
  /** Status-change time in nanoseconds; catches tools that restore mtimes (tar, rsync -t). */
  readonly ctimeNs: string;
  /** sha256 of the file's bytes. */
  readonly contentHash: string;
}

/** CLAUDE.md "Per-repo index": the file manifest and the last analyzed commit. */
export interface RepoIndex {
  /** Absolute project root, forward slashes. */
  readonly root: string;
  readonly lastCommit: string | null;
  /** When the scan that produced this manifest started (ns, decimal string); for the racy-mtime rule. */
  readonly scanStartedNs: string;
  readonly files: readonly ManifestEntry[];
}

export interface CacheStats {
  /** Where the store lives, if on disk. */
  readonly location?: string;
  readonly bytes: number;
  readonly facts: number;
  readonly repos: number;
  readonly manifestEntries: number;
  readonly derived: number;
}

/**
 * CLAUDE.md "Local cache": `core` defines the store, SQLite implements it in
 * `engine`, and tests use an in-memory version. Synchronous, matching
 * better-sqlite3. Facts keys hash the file contents, adapter id and version,
 * parser fingerprint and extractorConfigHash (ADR-004). Values never contain
 * file contents or code excerpts.
 */
export interface CacheStore extends DerivedStore {
  /** Cached facts, or undefined on a miss (or an entry that no longer validates). Marks the entry used. */
  getFacts(key: string): CachedFacts | undefined;
  putFacts(key: string, value: CachedFacts): void;
  getRepoIndex(root: string): RepoIndex | undefined;
  /** Replaces the repo's manifest and last commit. */
  putRepoIndex(index: RepoIndex): void;
  /** Runs fn atomically (batches writes on stores that support it). */
  transaction<T>(fn: () => T): T;
  stats(): CacheStats;
  clear(): void;
  /** Evicts least-recently-used facts and derived values until under `maxBytes`; returns entries removed. */
  prune(maxBytes: number): number;
  close(): void;
}

/**
 * CLAUDE.md "Bring your own keys". Lives only in the main process and the
 * analysis host; the renderer never sees a value.
 */
export interface SecretStore {
  set(provider: string, value: string): Promise<void>;
  get(provider: string): Promise<string | undefined>;
  has(provider: string): Promise<boolean>;
  delete(provider: string): Promise<void>;
}

/** CLAUDE.md "GitHistoryProvider" (M5). */
export interface GitHistoryProvider {
  /** too-short: history shorter than staleAfterDays. */
  status(): {
    usable: boolean;
    reason?: "not-a-repo" | "shallow" | "too-short";
  };
  firstIntroduced(flagName: string, files: string[]): Promise<Date | null>;
  /** Uncommitted lines count as "now". */
  lastTouched(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<Date | null>;
  lastTouchedFile(file: string): Promise<Date | null>;
}

/** What the generators found for a pair (ADR-008). Absent signals were not found. */
export interface HintSignals {
  /** Commits in the window (after the size cutoff) that changed both files, and each file. */
  readonly cochange?: {
    readonly together: number;
    readonly sourceCommits: number;
    readonly targetCommits: number;
  };
  /** Rare key-like strings both files use (rarest first, at most 10) and their summed rarity. */
  readonly strings?: {
    readonly shared: readonly string[];
    readonly weight: number;
  };
  /** Cosine similarity of the two files' embeddings. */
  readonly embedding?: { readonly cosine: number };
}

/**
 * A candidate relation produced before scoring; never all pairs (M6).
 * Directed: `source` likely changes when `target` changes, so a score is a
 * probability of that, and blast radius's reverse walk reads it as is.
 */
export interface CandidatePair {
  readonly source: string;
  readonly target: string;
  readonly signals: HintSignals;
}

export interface ScoredRelation {
  readonly source: string;
  readonly target: string;
  readonly probability: number;
  /** Short rationale tag. */
  readonly rationale: string;
}

export interface FileContext {
  readonly id: string;
  readonly language: string;
  readonly exports: readonly string[];
}

export interface FileRole {
  readonly id: string;
  /** Enum-like label, e.g. controller, model, util, test, config. */
  readonly label: string;
  readonly confidence: number;
}

/** CLAUDE.md "RelationScorer": models score hints, never facts or findings (M6). */
export interface RelationScorer {
  scoreRelations(candidates: CandidatePair[]): Promise<ScoredRelation[]>;
  classifyFiles(files: FileContext[]): Promise<FileRole[]>;
}
