import type { DerivedStore } from "@epoch-dev/core";
import { parseChurnLog } from "./churn.js";
import {
  GitError,
  defaultRunner,
  readHeadCommit,
  resolveGitDir,
  type GitRunner,
} from "./git.js";
import type { FsReader } from "./reader.js";

/*
 * Commit file sets for co-change hints (M6, ADR-008): the files each
 * non-merge commit touched in the window before HEAD's commit date, under
 * their current names (renames followed, as for churn). Anchored at HEAD,
 * so the same commit always gives the same sets; only commit trees are read,
 * behind GIT_HARDENING. Cached per HEAD in the derived store.
 */

export type CochangeStatus =
  "usable" | "shallow" | "not-a-repo" | "no-commits" | "git-unavailable";

export interface CommitSets {
  readonly status: CochangeStatus;
  /** Each commit's files, sorted; commits in a stable order. */
  readonly commits: readonly (readonly string[])[];
}

const NAMESPACE = "cochange";

function isCommitSets(v: unknown): v is CommitSets {
  if (typeof v !== "object" || v === null) return false;
  const { status, commits } = v as Record<string, unknown>;
  return (
    typeof status === "string" &&
    Array.isArray(commits) &&
    commits.every(
      (c) => Array.isArray(c) && c.every((f) => typeof f === "string"),
    )
  );
}

/**
 * The commit file sets of the repository at `root` (its top level). Never
 * throws: an unusable repository is reported in `status`.
 */
export function gitCommitSets(
  root: string,
  reader: FsReader,
  opts: {
    readonly days: number;
    readonly run?: GitRunner;
    readonly store?: DerivedStore;
  },
): CommitSets {
  const none = (status: CochangeStatus): CommitSets => ({
    status,
    commits: [],
  });
  const gitDir = resolveGitDir(reader, root);
  if (gitDir === undefined) return none("not-a-repo");
  const head = readHeadCommit(reader, root);
  if (head === null) return none("no-commits");
  const key = String(opts.days);
  const cached = opts.store?.getDerived(NAMESPACE, key);
  if (cached?.inputHash === head && isCommitSets(cached.value)) {
    return cached.value;
  }
  const run = opts.run ?? defaultRunner;
  try {
    const until = Number(
      run(
        ["log", "-1", "--no-show-signature", "--format=%ct", head, "--"],
        root,
      ).trim(),
    );
    if (!Number.isFinite(until)) return none("no-commits");
    const since = until - opts.days * 86_400;
    const out = run(
      [
        "log",
        "--no-merges",
        "--no-show-signature",
        "-z",
        "--name-status",
        "-M",
        "--no-ext-diff",
        "--no-textconv",
        "--format=%x01%H",
        `--since=${new Date(since * 1000).toISOString()}`,
        head,
        "--",
      ],
      root,
    );
    const byCommit = new Map<string, string[]>();
    for (const [file, commits] of parseChurnLog(out)) {
      for (const c of commits) {
        const files = byCommit.get(c);
        if (files) files.push(file);
        else byCommit.set(c, [file]);
      }
    }
    const result: CommitSets = {
      status: reader.fileExists(`${gitDir}/shallow`) ? "shallow" : "usable",
      commits: [...byCommit.keys()]
        .sort()
        .map((c) => (byCommit.get(c) ?? []).sort()),
    };
    opts.store?.putDerived(NAMESPACE, key, head, result);
    return result;
  } catch (err) {
    if (err instanceof GitError) return none("git-unavailable");
    throw err;
  }
}
