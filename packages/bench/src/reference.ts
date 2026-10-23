/**
 * Pure helpers that set up the ground-truth tool the way the analyzed
 * repository sets itself up: its workspace packages, the tsconfig that owns
 * each file, and the export conditions that tsconfig declares. Written here
 * from the package.json, pnpm-workspace.yaml and tsconfig formats, not taken
 * from Epoch's resolver, so the reference stays independent of what it checks.
 */
import path from "node:path";

/** The `packages` globs of a pnpm-workspace.yaml (a flat YAML list; quotes removed). */
export function pnpmWorkspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = /^packages\s*:/.test(line);
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) globs.push(item.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return globs;
}

/** The workspace globs of a package.json: `workspaces` as a list, or its `packages`. */
export function workspaceGlobs(pkg: Record<string, unknown>): string[] {
  const ws = pkg.workspaces;
  const list = Array.isArray(ws)
    ? ws
    : typeof ws === "object" && ws !== null
      ? (ws as { packages?: unknown }).packages
      : undefined;
  return Array.isArray(list)
    ? list.filter((g): g is string => typeof g === "string")
    : [];
}

const isSubpathMap = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.keys(v).some((k) => k.startsWith("."));

/** Every string target under an exports entry, in order, through conditions and arrays. */
function targetsOf(entry: unknown, star: string | undefined): string[] {
  if (typeof entry === "string") {
    const filled = star === undefined ? entry : entry.split("*").join(star);
    return [filled.replace(/^\.\//, "")];
  }
  if (Array.isArray(entry)) return entry.flatMap((e) => targetsOf(e, star));
  if (typeof entry === "object" && entry !== null)
    return Object.values(entry).flatMap((e) => targetsOf(e, star));
  return [];
}

/**
 * The files a package.json `exports` field can give for one subpath ("." or
 * "./v4"), under any condition, relative to the package directory. A subpath
 * pattern ("./locales/*") is filled in.
 */
export function exportTargets(exports: unknown, subpath: string): string[] {
  let entry: unknown;
  let star: string | undefined;
  if (!isSubpathMap(exports)) {
    if (subpath !== ".") return [];
    entry = exports;
  } else if (subpath in exports) {
    entry = exports[subpath];
  } else {
    for (const [key, value] of Object.entries(exports)) {
      const i = key.indexOf("*");
      if (i === -1) continue;
      const [before, after] = [key.slice(0, i), key.slice(i + 1)];
      if (
        subpath.length >= key.length - 1 &&
        subpath.startsWith(before) &&
        subpath.endsWith(after)
      ) {
        entry = value;
        star = subpath.slice(before.length, subpath.length - after.length);
        break;
      }
    }
  }
  return [...new Set(targetsOf(entry, star))];
}

/**
 * The tsconfig.json that owns a file, as an editor picks it: the closest one
 * up the folder tree whose file list includes the file. Undefined when none
 * does (the caller falls back to the repository's root tsconfig).
 */
export function nearestTsconfig(
  file: string,
  exists: (tsconfig: string) => boolean,
  includes: (tsconfig: string, file: string) => boolean,
): string | undefined {
  let dir = path.posix.dirname(file);
  for (;;) {
    const config = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
    if (exists(config) && includes(config, file)) return config;
    if (dir === ".") return undefined;
    dir = path.posix.dirname(dir);
  }
}
