import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { SkipReason } from "@epoch-dev/core";
import { readTrackedPaths, type TrackedPaths } from "./git-index.js";
import { FsReader } from "./reader.js";

/**
 * Build outputs and tool caches, not walked whatever the ignore files say
 * (PLAN.md M1 Discover), unless git tracks files inside: a tracked `build/`
 * is source (a Go package, a Python package named build).
 */
export const DEFAULT_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  // Python tool caches.
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
]);

/**
 * A directory holding one of these is a Python environment (installed
 * third-party code, not the project), whatever its name: every PEP 405
 * virtual environment has pyvenv.cfg at its root, every conda environment a
 * conda-meta directory.
 */
const ENVIRONMENT_MARKERS = ["pyvenv.cfg", "conda-meta"] as const;

/** Source files larger than this are skipped (minified bundles, generated blobs). */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Never walked, even when git tracks files inside: installed third-party code and git's own data. */
const ALWAYS_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
]);

/** Ignore files, and whether git's "tracked files are never ignored" rule applies to them. */
const IGNORE_FILES = [
  { name: ".gitignore", git: true },
  { name: ".epochignore", git: false },
] as const;

export interface DiscoverOptions {
  /** Whether a repo-relative path is a source file some adapter analyzes. */
  readonly isSource: (path: string) => boolean;
  readonly maxFileBytes?: number;
}

export interface DiscoverResult {
  /** Absolute project root, forward slashes. */
  readonly root: string;
  /** Every non-ignored, non-symlink file, repo-relative with forward slashes, sorted. */
  readonly files: string[];
  /** Files seen but not analyzed, with the reason. Ignored paths are not listed. */
  readonly skipped: { path: string; reason: SkipReason }[];
}

/** Converts an OS path to forward slashes (Windows backslashes, drive letters kept). */
export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

interface Scope {
  /** Repo-relative directory the rules apply to ("" for the root). */
  readonly dir: string;
  /** A .gitignore (tracked files override it) rather than an .epochignore. */
  readonly git: boolean;
  readonly ig: Ignore;
}

/**
 * Applies git's precedence: deeper ignore files override shallower ones, and
 * within a file the last matching rule wins (handled by `ignore`).
 */
function isIgnored(
  scopes: readonly Scope[],
  rel: string,
  isDir: boolean,
  git: boolean,
): boolean {
  let ignored = false;
  for (const { dir, ig, git: isGit } of scopes) {
    if (isGit !== git) continue;
    const local = dir === "" ? rel : rel.slice(dir.length + 1);
    const result = ig.test(isDir ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/** Tracked-path lookups; git never applies ignore rules to tracked files. */
function trackedLookup(tracked: TrackedPaths | undefined) {
  const dirs = new Set<string>();
  for (const f of tracked?.files ?? []) {
    for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1))
      dirs.add(f.slice(0, i));
  }
  const sparse = tracked?.sparseDirs ?? [];
  const inSparse = (rel: string) => sparse.some((d) => `${rel}/`.startsWith(d));
  return {
    file: (rel: string) => tracked?.files.has(rel) === true || inSparse(rel),
    dir: (rel: string) =>
      dirs.has(rel) ||
      inSparse(rel) ||
      sparse.some((d) => d.startsWith(`${rel}/`)),
  };
}

/**
 * Walks the project (Discover stage). Honours the root and nested .gitignore
 * and .epochignore files, skips DEFAULT_SKIPPED_DIRS unless git tracks files
 * inside (node_modules and .git always), never follows
 * symlinks (no cycles, no escaping the root of an untrusted project), and
 * skips oversized source files. As in git, a file git tracks is never hidden
 * by .gitignore (tracked paths come from .git/index, read as data);
 * .epochignore, the user's explicit choice, hides it anyway. Reads only
 * directory listings, ignore files, the git index and file sizes; never writes.
 */
export function discover(
  rootDir: string,
  opts: DiscoverOptions,
): DiscoverResult {
  const root = toPosix(path.resolve(rootDir));
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const tracked = trackedLookup(readTrackedPaths(new FsReader(root), root));
  const files: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];

  /** `gitIgnored`: an ancestor directory is gitignored, so only tracked files survive below it. */
  const walk = (
    rel: string,
    scopes: readonly Scope[],
    gitIgnored: boolean,
  ): void => {
    const abs = rel === "" ? root : `${root}/${rel}`;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      skipped.push({ path: rel === "" ? "." : rel, reason: "unreadable" });
      return;
    }
    if (
      rel !== "" &&
      entries.some((e) =>
        (ENVIRONMENT_MARKERS as readonly string[]).includes(e.name),
      )
    ) {
      return;
    }
    let here = scopes;
    for (const { name, git } of IGNORE_FILES) {
      if (!entries.some((e) => e.name === name && e.isFile())) continue;
      try {
        const text = fs.readFileSync(`${abs}/${name}`, "utf8");
        here = [...here, { dir: rel, git, ig: ignore().add(text) }];
      } catch {
        skipped.push({
          path: rel === "" ? name : `${rel}/${name}`,
          reason: "unreadable",
        });
      }
    }
    const sorted = [...entries].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of sorted) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (
          DEFAULT_SKIPPED_DIRS.has(entry.name) &&
          (ALWAYS_SKIPPED_DIRS.has(entry.name) || !tracked.dir(childRel))
        )
          continue;
        if (isIgnored(here, childRel, true, false)) continue;
        const ignoredHere = gitIgnored || isIgnored(here, childRel, true, true);
        if (ignoredHere && !tracked.dir(childRel)) continue;
        walk(childRel, here, ignoredHere);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, FIFOs, devices
      if (isIgnored(here, childRel, false, false)) continue;
      if (
        (gitIgnored || isIgnored(here, childRel, false, true)) &&
        !tracked.file(childRel)
      )
        continue;
      if (opts.isSource(childRel)) {
        let size: number;
        try {
          size = fs.statSync(`${root}/${childRel}`).size;
        } catch {
          skipped.push({ path: childRel, reason: "unreadable" });
          continue;
        }
        if (size > maxBytes) {
          skipped.push({ path: childRel, reason: "too-large" });
          continue;
        }
      }
      files.push(childRel);
    }
  };

  walk("", [], false);
  const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort(byCodeUnits);
  skipped.sort((a, b) => byCodeUnits(a.path, b.path));
  return { root, files, skipped };
}
