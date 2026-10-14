import childProcess from "node:child_process";
import type { FsReader } from "./reader.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The repository's git directory: `<root>/.git`, or the target of a `.git`
 * file's `gitdir:` line. Reads go through the root-confined reader, so a
 * gitdir outside the root (worktrees, submodules) reads as missing.
 */
export function resolveGitDir(
  reader: FsReader,
  root: string,
): string | undefined {
  const gitDir = `${root}/.git`;
  if (reader.directoryExists(gitDir)) return gitDir;
  const pointer = reader.readFile(gitDir)?.trim();
  const target = pointer?.startsWith("gitdir: ")
    ? pointer.slice(8).trim()
    : undefined;
  if (target === undefined) return undefined;
  return target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)
    ? target
    : `${root}/${target}`;
}

/**
 * The commit HEAD points at, read from `.git` as plain files (HEAD, loose refs,
 * packed-refs) through the root-confined reader. Runs no process, so a
 * repo-local git config can never execute anything. Returns null outside a
 * repository, for a `.git` pointing outside the root (worktrees), or for any
 * layout it does not understand: the commit is bookkeeping, never required.
 */
export function readHeadCommit(reader: FsReader, root: string): string | null {
  const gitDir = resolveGitDir(reader, root);
  if (gitDir === undefined) return null;
  const head = reader.readFile(`${gitDir}/HEAD`)?.trim();
  if (head === undefined) return null;
  if (OBJECT_ID.test(head)) return head; // detached HEAD
  if (!head.startsWith("ref: ")) return null;
  const ref = head.slice(5).trim();
  if (!/^refs\/[A-Za-z0-9._\-/]+$/.test(ref) || ref.includes("..")) return null;
  const loose = reader.readFile(`${gitDir}/${ref}`)?.trim();
  if (loose !== undefined) return OBJECT_ID.test(loose) ? loose : null;
  for (const line of reader.readFile(`${gitDir}/packed-refs`)?.split(/\r?\n/) ??
    []) {
    const [id, name] = line.split(" ");
    if (name === ref && id !== undefined && OBJECT_ID.test(id)) return id;
  }
  return null; // unborn branch
}

/** --since could not be honoured: git missing, not a repository, unknown commit. */
export class GitError extends Error {}

/** Runs git; injectable so tests can assert the exact arguments. */
export type GitRunner = (args: readonly string[], cwd: string) => string;

/**
 * Options and environment for every git call. Only read-only, tree-level
 * commands are used, and these keep repo-local configuration from running
 * anything: no fsmonitor hook, no external diff or textconv drivers, no
 * pager, no prompts, and no optional index locks (git never writes .git).
 */
export const GIT_HARDENING = [
  "-c",
  "core.fsmonitor=false",
  "--no-pager",
] as const;

const defaultRunner: GitRunner = (args, cwd) => {
  try {
    return childProcess.execFileSync("git", [...GIT_HARDENING, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: unknown };
    if (e.code === "ENOENT")
      throw new GitError("--since needs git, which is not installed");
    const stderr =
      typeof e.stderr === "string" ? e.stderr.trim().split("\n")[0] : undefined;
    throw new GitError(`git failed: ${stderr ?? e.message}`);
  }
};

/**
 * Repo-relative paths (under `root`) changed between `since` and HEAD, for
 * --since. Compares two trees only: it never reads the working tree or the
 * index, where repo-configured filters could run. Uncommitted edits are
 * caught by the regular stat/hash change detection.
 */
export function changedSince(
  root: string,
  since: string,
  run: GitRunner = defaultRunner,
): string[] {
  if (since === "" || since.startsWith("-") || /\s/.test(since)) {
    throw new GitError(`not a commit: ${JSON.stringify(since)}`);
  }
  let commit: string;
  try {
    commit = run(
      ["rev-parse", "--verify", "--quiet", `${since}^{commit}`],
      root,
    ).trim();
  } catch (err) {
    if (err instanceof GitError && err.message.includes("not installed"))
      throw err;
    throw new GitError(
      `unknown commit ${JSON.stringify(since)} (is this a git repository, or a shallow clone missing it?)`,
    );
  }
  if (!OBJECT_ID.test(commit))
    throw new GitError(`unknown commit ${JSON.stringify(since)}`);
  const out = run(
    [
      "diff",
      "--name-only",
      "-z",
      "--relative",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      commit,
      "HEAD",
      "--",
    ],
    root,
  );
  return out.split("\0").filter((p) => p !== "");
}
