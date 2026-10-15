import { z } from "zod";
import { globMatcher } from "@epoch-dev/core";
import frameworks from "./frameworks.json" with { type: "json" };

/*
 * Frameworks that load files by convention rather than by import (CLAUDE.md
 * "Unreachable files"): data, validated here, extended via ADR. Every entry
 * cites the framework's own docs, pinned to a commit on GitHub. A file inside
 * a detected framework's convention paths is capped at Low when no root
 * reaches it, and the UI suggests `entryPoints` configuration.
 */

const Framework = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  ecosystem: z.enum(["npm", "python"]),
  /** Dependency names that reveal the framework (npm names, or normalized Python names). */
  dependencies: z.array(z.string().min(1)).min(1),
  /** File names that reveal it on their own, e.g. Django's manage.py. */
  markerFiles: z.array(z.string().min(1)),
  /** Globs, relative to the directory of the manifest or marker that revealed it. */
  conventions: z.array(z.string().min(1)).min(1),
  sources: z.array(z.url().startsWith("https://github.com/")).min(1),
});
export type Framework = z.infer<typeof Framework>;

export const FRAMEWORKS: readonly Framework[] = frameworks.map((f) =>
  Framework.parse(f),
);

/** A manifest's declared dependencies, from the engine (package.json, pyproject.toml, requirements). */
export interface ManifestDependencies {
  /** Repo-relative directory of the manifest ("" for the root). */
  readonly dir: string;
  readonly ecosystem: "npm" | "python";
  readonly dependencies: readonly string[];
}

export interface DetectedFramework {
  readonly id: string;
  readonly name: string;
  /** Repo-relative directory its conventions apply under. */
  readonly dir: string;
  /** Why it was detected, e.g. "package.json depends on next". */
  readonly evidence: string;
  /** Globs of the convention-loaded paths, relative to `dir`. */
  readonly conventions: readonly string[];
}

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * Frameworks present in the repository, one per (framework, directory),
 * sorted by directory then id.
 */
export function detectFrameworks(
  manifests: readonly ManifestDependencies[],
  files: readonly string[],
  list: readonly Framework[] = FRAMEWORKS,
): DetectedFramework[] {
  const found = new Map<string, DetectedFramework>();
  const add = (f: Framework, dir: string, evidence: string) => {
    const key = `${dir}\u0000${f.id}`;
    if (found.has(key)) return;
    found.set(key, {
      id: f.id,
      name: f.name,
      dir,
      evidence,
      conventions: f.conventions,
    });
  };
  for (const f of list) {
    for (const m of manifests) {
      if (m.ecosystem !== f.ecosystem) continue;
      const dep = f.dependencies.find((d) => m.dependencies.includes(d));
      if (dep !== undefined) {
        add(
          f,
          m.dir,
          `${m.dir === "" ? "" : `${m.dir}/`}${f.ecosystem === "npm" ? "package.json" : "project"} depends on ${dep}`,
        );
      }
    }
    for (const file of files) {
      if (f.markerFiles.includes(baseOf(file)))
        add(f, dirOf(file), `${file} exists`);
    }
  }
  return [...found.values()].sort((a, b) =>
    a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : a.id < b.id ? -1 : 1,
  );
}

/** A predicate: is this repo-relative path inside some detected framework's conventions? */
export function frameworkMatcher(
  detected: readonly DetectedFramework[],
): (path: string) => DetectedFramework | undefined {
  const matchers = detected.map((d) => ({
    d,
    match: globMatcher(d.conventions),
  }));
  return (path) =>
    matchers.find(({ d, match }) =>
      d.dir === ""
        ? match(path)
        : path.startsWith(`${d.dir}/`) && match(path.slice(d.dir.length + 1)),
    )?.d;
}
