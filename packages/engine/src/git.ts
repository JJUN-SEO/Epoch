import type { FsReader } from "./reader.js";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The commit HEAD points at, read from `.git` as plain files (HEAD, loose refs,
 * packed-refs) through the root-confined reader. Runs no process, so a
 * repo-local git config can never execute anything. Returns null outside a
 * repository, for a `.git` pointing outside the root (worktrees), or for any
 * layout it does not understand: the commit is bookkeeping, never required.
 */
export function readHeadCommit(reader: FsReader, root: string): string | null {
  let gitDir = `${root}/.git`;
  if (!reader.directoryExists(gitDir)) {
    const pointer = reader.readFile(gitDir)?.trim();
    const target = pointer?.startsWith("gitdir: ")
      ? pointer.slice(8).trim()
      : undefined;
    if (target === undefined) return null;
    gitDir =
      target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target)
        ? target
        : `${root}/${target}`;
  }
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
