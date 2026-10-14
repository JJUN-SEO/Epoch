import type { FileFacts } from "../schemas/index.js";

/**
 * CLAUDE.md "Local cache": `core` defines the store, SQLite implements it in
 * `engine` (M2), and tests use an in-memory version. Synchronous, matching
 * better-sqlite3. Keys are hash(contents + adapter id + adapter version +
 * extractorConfigHash). Values never contain file contents.
 */
export interface CacheStore {
  getFacts(key: string): FileFacts | undefined;
  putFacts(key: string, facts: FileFacts): void;
  stats(): { entries: number; bytes: number };
  clear(): void;
  /** Evicts least-recently-used entries until under `maxBytes`; returns entries removed. */
  prune(maxBytes: number): number;
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

/** A candidate relation produced before scoring; never all pairs (M6). */
export interface CandidatePair {
  readonly source: string;
  readonly target: string;
  /** Which generators proposed it, e.g. "cochange", "embedding". */
  readonly signals: readonly string[];
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
