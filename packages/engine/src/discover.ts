import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { SkipReason } from "@epoch-dev/core";

/** Directories never walked, whatever the ignore files say (PLAN.md M1 Discover). */
export const DEFAULT_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
]);

/** Source files larger than this are skipped (minified bundles, generated blobs). */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

const IGNORE_FILES = [".gitignore", ".epochignore"] as const;

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
): boolean {
  let ignored = false;
  for (const { dir, ig } of scopes) {
    const local = dir === "" ? rel : rel.slice(dir.length + 1);
    const result = ig.test(isDir ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Walks the project (Discover stage). Honours the root and nested .gitignore
 * and .epochignore files, always skips DEFAULT_SKIPPED_DIRS, never follows
 * symlinks (no cycles, no escaping the root of an untrusted project), and
 * skips oversized source files. Reads only directory listings, ignore files
 * and file sizes; never writes.
 */
export function discover(
  rootDir: string,
  opts: DiscoverOptions,
): DiscoverResult {
  const root = toPosix(path.resolve(rootDir));
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const files: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];

  const walk = (rel: string, scopes: readonly Scope[]): void => {
    const abs = rel === "" ? root : `${root}/${rel}`;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      skipped.push({ path: rel === "" ? "." : rel, reason: "unreadable" });
      return;
    }
    let here = scopes;
    for (const name of IGNORE_FILES) {
      if (!entries.some((e) => e.name === name && e.isFile())) continue;
      try {
        const text = fs.readFileSync(`${abs}/${name}`, "utf8");
        here = [...here, { dir: rel, ig: ignore().add(text) }];
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
        if (DEFAULT_SKIPPED_DIRS.has(entry.name)) continue;
        if (isIgnored(here, childRel, true)) continue;
        walk(childRel, here);
        continue;
      }
      if (!entry.isFile()) continue; // sockets, FIFOs, devices
      if (isIgnored(here, childRel, false)) continue;
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

  walk("", []);
  const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort(byCodeUnits);
  skipped.sort((a, b) => byCodeUnits(a.path, b.path));
  return { root, files, skipped };
}
