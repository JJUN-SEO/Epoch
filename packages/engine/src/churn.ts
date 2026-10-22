import {
  GitError,
  defaultRunner,
  readHeadCommit,
  resolveGitDir,
  type GitRunner,
} from "./git.js";
import type { FsReader } from "./reader.js";

/*
 * Git churn (PLAN.md M4): how many commits touched each file in the 90 days
 * before the HEAD commit. Anchoring the window at HEAD's date, not at "now",
 * keeps the graph a function of the repository's state, so the same commit
 * always gives the same numbers. Merge commits are skipped, renames are
 * followed to each file's current name, and only commit trees are read (never
 * the working tree), behind GIT_HARDENING.
 */

export const CHURN_DAYS = 90;

export type ChurnStatus =
  | {
      readonly usable: true;
      /** The clone has only part of its history (.git/shallow). */
      readonly shallow: boolean;
      readonly head: string;
      /** Window start and end, Unix seconds (HEAD's committer date). */
      readonly since: number;
      readonly until: number;
    }
  | {
      readonly usable: false;
      readonly reason: "not-a-repo" | "no-commits" | "git-unavailable";
    };

export interface Churn {
  readonly status: ChurnStatus;
  /** Repo-relative path -> the commits that touched it in the window. */
  readonly commits: ReadonlyMap<string, ReadonlySet<string>>;
}

const MARK = "\u0001";

/**
 * Parses `git log -z --name-status -M --format=%x01%H` (newest first) into
 * the commits per current path: a commit that touched `old` before a rename
 * to `new` counts for `new`.
 */
export function parseChurnLog(out: string): Map<string, Set<string>> {
  const tokens = out.split("\0");
  const currentName = new Map<string, string>();
  const commits = new Map<string, Set<string>>();
  const count = (path: string, commit: string) => {
    const name = currentName.get(path) ?? path;
    const set = commits.get(name);
    if (set) set.add(commit);
    else commits.set(name, new Set([commit]));
  };
  let commit: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (token.startsWith(MARK)) {
      commit = token.slice(1).trim();
      continue;
    }
    const status = token.trim();
    if (status === "" || commit === undefined) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = tokens[++i] ?? "";
      const to = tokens[++i] ?? "";
      count(to, commit);
      // Older commits saw this file under its previous name.
      if (status.startsWith("R"))
        currentName.set(from, currentName.get(to) ?? to);
    } else {
      count(tokens[++i] ?? "", commit);
    }
  }
  commits.delete("");
  return commits;
}

/**
 * Churn for the repository at `root` (its top level: a `.git` at the root).
 * Never throws: an unusable repository is reported in `status`.
 */
export function gitChurn(
  root: string,
  reader: FsReader,
  run: GitRunner = defaultRunner,
  days = CHURN_DAYS,
): Churn {
  const none = (
    reason: "not-a-repo" | "no-commits" | "git-unavailable",
  ): Churn => ({
    status: { usable: false, reason },
    commits: new Map(),
  });
  const gitDir = resolveGitDir(reader, root);
  if (gitDir === undefined) return none("not-a-repo");
  const head = readHeadCommit(reader, root);
  if (head === null) return none("no-commits");
  try {
    const until = Number(
      run(
        ["log", "-1", "--no-show-signature", "--format=%ct", head, "--"],
        root,
      ).trim(),
    );
    if (!Number.isFinite(until)) return none("no-commits");
    const since = until - days * 86_400;
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
    return {
      status: {
        usable: true,
        shallow: reader.fileExists(`${gitDir}/shallow`),
        head,
        since,
        until,
      },
      commits: parseChurnLog(out),
    };
  } catch (err) {
    if (err instanceof GitError) return none("git-unavailable");
    throw err;
  }
}
