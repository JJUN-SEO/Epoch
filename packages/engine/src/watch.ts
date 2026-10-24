import fs, { type Stats } from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import type { WatchStatus } from "@epoch-dev/core";
import { analyze, type AnalyzeOptions, type AnalyzeResult } from "./analyze.js";
import { DEFAULT_SKIPPED_DIRS, toPosix } from "./discover.js";
import {
  GitError,
  changedSince,
  readHeadCommit,
  type GitRunner,
} from "./git.js";
import { FsReader } from "./reader.js";

/*
 * The file watcher (CLAUDE.md "Local cache": change detection; PLAN.md M4).
 * Events are batched until the tree is quiet, then the incremental analysis
 * runs again: unchanged files come from the cache, resolution and the graph
 * are recomputed (ADR-004). Directories Discover does not walk are never
 * watched, which keeps large repositories under the OS watch limits.
 */

/** Editor temp, swap and backup files: never a reason to re-analyze. */
export function isEditorNoise(name: string): boolean {
  return (
    /\.(?:sw[a-p]|swx|tmp)$/.test(name) || // vim swap files, generic temp files
    name.endsWith("~") || // emacs and vim backups
    name.startsWith(".#") || // emacs lock files
    name === "4913" || // vim's write-permission probe
    name.endsWith("___jb_tmp___") || // JetBrains safe write
    name.endsWith("___jb_old___") ||
    name === ".DS_Store"
  );
}

/** Never watched: installed third-party code and git's own data. */
const NEVER_WATCHED = new Set(["node_modules", ".git"]);

/** Coverage report paths and every folder above them. */
function reportPaths(paths: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++)
      out.add(parts.slice(0, i).join("/"));
  }
  return out;
}

/**
 * Collects paths and calls `flush` once no new path arrived for `quietMs`,
 * or `maxMs` after the first path of a batch, whichever comes first, so a
 * steady stream of events (a build, a branch switch) still gets analyzed.
 */
export class Debouncer {
  private readonly quietMs: number;
  private readonly maxMs: number;
  private readonly onFlush: (paths: ReadonlySet<string>) => void;
  private pending = new Set<string>();
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private max: ReturnType<typeof setTimeout> | undefined;

  constructor(
    quietMs: number,
    maxMs: number,
    onFlush: (paths: ReadonlySet<string>) => void,
  ) {
    this.quietMs = quietMs;
    this.maxMs = maxMs;
    this.onFlush = onFlush;
  }

  add(p: string): void {
    this.pending.add(p);
    clearTimeout(this.quiet);
    this.quiet = setTimeout(() => {
      this.flush();
    }, this.quietMs);
    this.max ??= setTimeout(() => {
      this.flush();
    }, this.maxMs);
  }

  flush(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.max);
    this.quiet = undefined;
    this.max = undefined;
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Set();
    this.onFlush(batch);
  }

  dispose(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.max);
    this.pending.clear();
  }
}

export interface WatchOptions {
  /** Options for each re-analysis (cache, pool, churn memo...). */
  readonly analyze?: AnalyzeOptions;
  /** Every re-analysis result, in order. */
  readonly onUpdate: (
    result: AnalyzeResult,
    changed: ReadonlySet<string>,
  ) => void;
  readonly onStatus?: (status: WatchStatus) => void;
  readonly quietMs?: number;
  readonly maxMs?: number;
  /** How often HEAD is read, to notice commits and branch switches. */
  readonly headPollMs?: number;
  readonly git?: GitRunner;
}

export const WATCH_LIMIT_MESSAGE =
  "The file watcher reached the operating system's limit on watched files (on Linux, fs.inotify.max_user_watches). Live updates are off; the graph stays as it is, and reopening the project analyzes it again.";

/** A watched project. Close it to stop watching and wait for any analysis in flight. */
export interface ProjectWatcher {
  close(): Promise<void>;
  /**
   * Re-analyzes now with new options, which later re-analyses keep (the app
   * adds the local embedding model this way after the first graph is shown).
   * Queued behind any re-analysis in flight; reported through onUpdate.
   */
  reconfigure(analyze: AnalyzeOptions): Promise<void>;
}

/**
 * Watches a project after its first analysis and re-analyzes it after each
 * batch of changes. A batch's paths are re-read even if their size and
 * modification time look unchanged; when HEAD moved (a commit, a branch
 * switch), files changed between the two commits are re-read too.
 */
export async function watchProject(
  initial: AnalyzeResult,
  opts: WatchOptions,
): Promise<ProjectWatcher> {
  const root = initial.root;
  const reader = new FsReader(root);
  let walked = new Set(initial.dirs.walked);
  let skipped = new Set(initial.dirs.skipped);
  let head = readHeadCommit(reader, root);
  let analyzeOptions = opts.analyze;
  // Fields, not locals: callbacks change them, and the checks must re-read them.
  const life = { closed: false, stopped: false };
  const isClosed = (): boolean => life.closed;
  let running = Promise.resolve();
  const status = (s: WatchStatus) => opts.onStatus?.(s);

  let reports = reportPaths(initial.coveragePaths);

  const ignored = (abs: string, stats?: Stats): boolean => {
    const rel = toPosix(path.relative(root, abs));
    if (rel === "") return false;
    if (rel.startsWith("../") || rel === ".." || path.isAbsolute(rel))
      return true;
    const parts = rel.split("/");
    if (parts.some((p) => NEVER_WATCHED.has(p))) return true;
    // A coverage report, or a folder on the way to one, even where Discover
    // does not walk (coverage/): only the report itself is watched there.
    if (reports.has(rel)) return false;
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (skipped.has(dir)) return true;
      if (
        (i < parts.length || stats?.isFile() !== true) &&
        DEFAULT_SKIPPED_DIRS.has(parts[i - 1] ?? "") &&
        !walked.has(dir)
      ) {
        return true;
      }
    }
    const name = parts[parts.length - 1] ?? "";
    return stats?.isDirectory() !== true && isEditorNoise(name);
  };

  const reanalyze = async (changed: ReadonlySet<string>): Promise<void> => {
    if (life.closed) return;
    status({ state: "updating" });
    try {
      const forceReread = new Set(changed);
      forceReread.delete(".git/HEAD");
      const newHead = readHeadCommit(reader, root);
      if (newHead !== head && head !== null && newHead !== null) {
        try {
          for (const f of changedSince(root, head, opts.git))
            forceReread.add(f);
        } catch (err) {
          if (!(err instanceof GitError)) throw err;
          // Without git the stat and hash checks still catch every edit.
        }
      }
      const result = await analyze(root, {
        ...analyzeOptions,
        forceReread,
        ...(opts.git ? { git: opts.git } : {}),
      });
      head = newHead;
      const nowSkipped = new Set(result.dirs.skipped);
      const nowWalked = new Set(result.dirs.walked);
      // Directories an ignore file or a new environment now hides stop being
      // watched; ones it no longer hides start.
      const unwatch = [...nowSkipped].filter((d) => !skipped.has(d));
      const rewatch = [...nowWalked].filter(
        (d) => d !== "" && !walked.has(d) && skipped.has(d),
      );
      skipped = nowSkipped;
      walked = nowWalked;
      // New report paths (a new project folder, a chosen report) start being
      // watched where they exist; the rest are seen when they appear.
      const nowReports = reportPaths(result.coveragePaths);
      const newReports = [...nowReports].filter(
        (p) => !reports.has(p) && fs.existsSync(path.join(root, p)),
      );
      reports = nowReports;
      if (!isClosed()) {
        if (unwatch.length > 0)
          watcher.unwatch(unwatch.map((d) => `${root}/${d}`));
        if (rewatch.length > 0) watcher.add(rewatch.map((d) => `${root}/${d}`));
        if (newReports.length > 0)
          watcher.add(newReports.map((p) => `${root}/${p}`));
        opts.onUpdate(result, changed);
        status({ state: "watching" });
      }
    } catch (err) {
      if (!isClosed()) {
        status({
          state: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const debouncer = new Debouncer(
    opts.quietMs ?? 300,
    opts.maxMs ?? 2000,
    (batch) => {
      running = running.then(() => reanalyze(batch));
    },
  );

  const watcher: FSWatcher = watch(root, {
    ignored,
    ignoreInitial: true,
    followSymlinks: false,
    persistent: true,
  });
  const stop = async (message: string) => {
    if (life.stopped) return;
    life.stopped = true;
    debouncer.dispose();
    clearInterval(poll);
    await watcher.close();
    status({ state: "stopped", message });
  };
  watcher.on("all", (_event, abs) => {
    const rel = toPosix(path.relative(root, abs));
    if (rel !== "" && !life.stopped) debouncer.add(rel);
  });
  watcher.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    void stop(
      code === "ENOSPC" || code === "EMFILE"
        ? WATCH_LIMIT_MESSAGE
        : `The file watcher failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const poll = setInterval(() => {
    if (readHeadCommit(reader, root) !== head) debouncer.add(".git/HEAD");
  }, opts.headPollMs ?? 2000);
  poll.unref();

  await new Promise<void>((resolve) => {
    watcher.once("ready", () => {
      resolve();
    });
  });
  if (!life.stopped) status({ state: "watching" });

  return {
    async close() {
      life.closed = true;
      life.stopped = true;
      debouncer.dispose();
      clearInterval(poll);
      await watcher.close();
      await running;
    },
    async reconfigure(next) {
      analyzeOptions = next;
      running = running.then(() => reanalyze(new Set()));
      await running;
    },
  };
}
