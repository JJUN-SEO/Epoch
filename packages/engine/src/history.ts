import type { DerivedStore, GitHistoryProvider } from "@epoch-dev/core";
import {
  GitError,
  defaultRunner,
  readHeadCommit,
  resolveGitDir,
  type GitRunner,
} from "./git.js";
import { splitLines, unchangedLines } from "./line-diff.js";
import type { FsReader } from "./reader.js";

/*
 * Git history for findings (CLAUDE.md "GitHistoryProvider", ADR-007).
 * "Now" is HEAD's committer date, so findings stay a function of the
 * repository. Every query reads commit trees only (blame and log on HEAD,
 * blobs by name); uncommitted lines are found by an in-process line diff,
 * so no repo-configured filter, textconv or external diff ever runs. Results
 * are cached in the cache's derived store, keyed by HEAD, path and query.
 */

const NAMESPACE = "git-history";
const DAY_S = 86_400;

type Status = ReturnType<GitHistoryProvider["status"]>;

interface HistoryState {
  readonly root: string;
  readonly reader: FsReader;
  readonly run: GitRunner;
  readonly status: Status;
  /** HEAD commit and its committer date (Unix seconds); unset outside a repository. */
  readonly head: { readonly commit: string; readonly time: number } | undefined;
  readonly store: DerivedStore | undefined;
  /** The repository has a .git-blame-ignore-revs file. */
  readonly ignoreRevs: boolean;
}

export class GitHistory implements GitHistoryProvider {
  private readonly blobs = new Map<string, string | null>();
  private readonly s: HistoryState;

  private constructor(state: HistoryState) {
    this.s = state;
  }

  /**
   * Opens the repository at `root` (its top level). Never throws: a missing
   * repository, a shallow clone, or history shorter than `staleAfterDays`
   * is reported by status().
   */
  static open(
    root: string,
    reader: FsReader,
    opts: {
      readonly staleAfterDays: number;
      readonly run?: GitRunner;
      readonly store?: DerivedStore;
    },
  ): GitHistory {
    const run = opts.run ?? defaultRunner;
    const base = { root, reader, run, store: opts.store, ignoreRevs: false };
    const unusable = (
      reason: NonNullable<Status["reason"]>,
      head?: { commit: string; time: number },
    ) => new GitHistory({ ...base, status: { usable: false, reason }, head });
    const gitDir = resolveGitDir(reader, root);
    const commit = readHeadCommit(reader, root);
    if (gitDir === undefined || commit === null) return unusable("not-a-repo");
    try {
      const time = Number(
        run(
          ["log", "-1", "--no-show-signature", "--format=%ct", commit, "--"],
          root,
        ).trim(),
      );
      if (!Number.isFinite(time)) return unusable("not-a-repo");
      const head = { commit, time };
      if (reader.fileExists(`${gitDir}/shallow`))
        return unusable("shallow", head);
      const first = run(
        [
          "log",
          "--max-parents=0",
          "--no-show-signature",
          "--format=%ct",
          commit,
          "--",
        ],
        root,
      )
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map(Number)
        .filter(Number.isFinite);
      const oldest = Math.min(...first);
      if (
        !Number.isFinite(oldest) ||
        time - oldest < opts.staleAfterDays * DAY_S
      ) {
        return unusable("too-short", head);
      }
      return new GitHistory({
        ...base,
        status: { usable: true },
        head,
        ignoreRevs: reader.fileExists(`${root}/.git-blame-ignore-revs`),
      });
    } catch (err) {
      if (err instanceof GitError) return unusable("not-a-repo");
      throw err;
    }
  }

  status(): Status {
    return this.s.status;
  }

  /** HEAD's committer date: the "now" ages are measured against. Undefined outside a repository. */
  now(): Date | undefined {
    return this.s.head === undefined
      ? undefined
      : new Date(this.s.head.time * 1000);
  }

  /** A query's answer, from the derived store when HEAD has not moved. */
  private cached(key: string, compute: () => number | null): number | null {
    const head = this.s.head?.commit ?? "";
    const hit = this.s.store?.getDerived(NAMESPACE, key);
    if (
      hit?.inputHash === head &&
      (typeof hit.value === "number" || hit.value === null)
    ) {
      return hit.value;
    }
    const value = compute();
    this.s.store?.putDerived(NAMESPACE, key, head, value);
    return value;
  }

  private git(args: readonly string[]): string | undefined {
    try {
      return this.s.run(args, this.s.root);
    } catch (err) {
      if (err instanceof GitError) return undefined;
      throw err;
    }
  }

  /** The file at HEAD, or null when HEAD does not have it. */
  private headBlob(file: string): string | null {
    let blob = this.blobs.get(file);
    if (blob === undefined) {
      blob = this.git(["cat-file", "blob", `HEAD:${file}`]) ?? null;
      this.blobs.set(file, blob);
    }
    return blob;
  }

  private headTime(): number {
    return this.s.head?.time ?? 0;
  }

  private date(seconds: number | null): Date | null {
    return seconds === null ? null : new Date(seconds * 1000);
  }

  firstIntroduced(flagName: string, files: string[]): Promise<Date | null> {
    if (!this.s.status.usable || files.length === 0)
      return Promise.resolve(null);
    const key = `introduced\u0000${flagName}\u0000${[...files].sort().join("\u0000")}`;
    return Promise.resolve(
      this.date(
        this.cached(key, () => {
          // -S is a fixed string (no regex from repository text); oldest first.
          const out = this.git([
            "log",
            "--reverse",
            "--no-show-signature",
            "--no-ext-diff",
            "--no-textconv",
            "--format=%ct",
            `-S${flagName}`,
            "HEAD",
            "--",
            ...files,
          ]);
          const first = Number(out?.split("\n")[0]);
          return out === undefined ||
            out.trim() === "" ||
            !Number.isFinite(first)
            ? null
            : first;
        }),
      ),
    );
  }

  lastTouched(
    file: string,
    startLine: number,
    endLine: number,
  ): Promise<Date | null> {
    if (!this.s.status.usable) return Promise.resolve(null);
    const now = this.headTime();
    const working = this.s.reader.readFile(`${this.s.root}/${file}`);
    const blob = this.headBlob(file);
    if (working === undefined || blob === null)
      return Promise.resolve(this.date(now));
    const map = unchangedLines(splitLines(blob), splitLines(working));
    if (map === undefined) return Promise.resolve(this.date(now));
    const headLines: number[] = [];
    for (let line = startLine; line <= endLine; line++) {
      const at = map[line - 1];
      if (at === undefined || at === -1) return Promise.resolve(this.date(now)); // uncommitted: now
      headLines.push(at + 1);
    }
    const from = Math.min(...headLines);
    const to = Math.max(...headLines);
    const key = `blame\u0000${file}\u0000${String(from)}\u0000${String(to)}`;
    return Promise.resolve(
      this.date(
        this.cached(key, () => {
          const out = this.git([
            "blame",
            "--porcelain",
            "-w",
            ...(this.s.ignoreRevs
              ? ["--ignore-revs-file", ".git-blame-ignore-revs"]
              : []),
            "-L",
            `${String(from)},${String(to)}`,
            "HEAD",
            "--",
            file,
          ]);
          if (out === undefined) return null;
          let newest: number | null = null;
          for (const line of out.split("\n")) {
            if (!line.startsWith("committer-time ")) continue;
            const t = Number(line.slice(15));
            if (Number.isFinite(t) && (newest === null || t > newest))
              newest = t;
          }
          return newest;
        }),
      ),
    );
  }

  lastTouchedFile(file: string): Promise<Date | null> {
    if (!this.s.status.usable) return Promise.resolve(null);
    const working = this.s.reader.readFile(`${this.s.root}/${file}`);
    const blob = this.headBlob(file);
    if (
      working === undefined ||
      blob === null ||
      splitLines(working).join("\n") !== splitLines(blob).join("\n")
    ) {
      return Promise.resolve(this.date(this.headTime())); // uncommitted changes: now
    }
    return Promise.resolve(
      this.date(
        this.cached(`file\u0000${file}`, () => {
          const out = this.git([
            "log",
            "-1",
            "--no-show-signature",
            "--format=%ct",
            "HEAD",
            "--",
            file,
          ]);
          const t = Number(out?.trim());
          return out === undefined || out.trim() === "" || !Number.isFinite(t)
            ? null
            : t;
        }),
      ),
    );
  }
}
