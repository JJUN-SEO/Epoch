import type {
  EntryPoint,
  EpochConfig,
  FileFacts,
  Finding,
  GitHistoryProvider,
  Graph,
} from "@epoch-dev/core";
import type { DetectedFramework } from "./frameworks.js";

/** An analyzed source file, as the detectors see it. */
export interface FindingsFile {
  /** Repo-relative, forward slashes. */
  readonly path: string;
  /** GraphNode.language, e.g. "typescript", "python", "go". */
  readonly language: string;
  readonly isTest: boolean;
  readonly facts: Pick<
    FileFacts,
    "flagUsages" | "constantConditions" | "isGenerated"
  >;
}

/** Git history state for findings: usable, a reason it is not, or "off" (not asked for). */
export type HistoryStatus =
  "usable" | "not-a-repo" | "shallow" | "too-short" | "off";

export interface FindingsInput {
  /** The Graph after Score; its findings are ignored. */
  readonly graph: Graph;
  readonly files: readonly FindingsFile[];
  /** Package node id -> its member files (Go, ADR-013). */
  readonly packages: ReadonlyMap<string, readonly string[]>;
  /** Entry points: adapter roots, test files and configured entryPoints. */
  readonly roots: readonly EntryPoint[];
  /** Directories of the package manifests (package.json, pyproject.toml, go.mod...); tsconfig folders are not packages. */
  readonly packageDirs: readonly string[];
  readonly frameworks: readonly DetectedFramework[];
  readonly config: EpochConfig;
  /** Absent when history is off. */
  readonly history?: GitHistoryProvider;
  /** The time ages are measured against (HEAD's commit date; ADR-007). */
  readonly now: Date;
  /** A stable string hash (sha256 hex in the engine), injected to keep this package pure. */
  readonly hash: (text: string) => string;
  /**
   * A hint edge at or above this confidence is strong enough to cap an
   * unreachable-file finding (default: HINT_DEFAULTS.threshold, ADR-008).
   */
  readonly hintThreshold?: number;
}

export interface FindingsOutput {
  /** Sorted by (kind, subject.name, id). */
  readonly findings: Finding[];
  /** Flag usages whose key is not a string literal (cannot be assessed). */
  readonly unassessableFlags: number;
  readonly history: HistoryStatus;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `then` to `now` (0 if `then` is later). */
export const daysBetween = (then: Date, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - then.getTime()) / DAY_MS));

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** Up to `max` items, then "and N more". */
export function listSome(items: readonly string[], max = 5): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max
    ? `${shown} and ${String(items.length - max)} more`
    : shown;
}
