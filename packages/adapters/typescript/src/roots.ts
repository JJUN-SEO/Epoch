import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ProjectRoot, RepoView } from "@epoch-dev/core";

/** Root kinds this adapter reports. */
export const ROOT_KINDS = {
  tsconfig: "tsconfig",
  package: "package",
  workspaceRoot: "workspace-root",
  workspacePackage: "workspace-package",
} as const;

const dirOf = (file: string): string => {
  const i = file.lastIndexOf("/");
  return i === -1 ? "" : file.slice(0, i);
};
const baseOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
const abs = (repo: RepoView, rel: string): string =>
  rel === "" ? repo.root : `${repo.root}/${rel}`;

function readJson(repo: RepoView, rel: string): unknown {
  const text = repo.reader.readFile(abs(repo, rel));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // malformed manifests are data errors, not crashes
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Workspace globs from package.json `workspaces` (array or {packages}) or pnpm-workspace.yaml. */
function workspaceGlobs(repo: RepoView): string[] | undefined {
  const pkg = readJson(repo, "package.json");
  if (isRecord(pkg)) {
    const ws = pkg.workspaces;
    if (Array.isArray(ws)) return strings(ws);
    if (isRecord(ws)) return strings(ws.packages);
  }
  const yamlText = repo.reader.readFile(abs(repo, "pnpm-workspace.yaml"));
  if (yamlText !== undefined) {
    try {
      // Plain data: the yaml package does not execute anything or resolve custom tags.
      const doc: unknown = parseYaml(yamlText);
      if (isRecord(doc)) return strings(doc.packages);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Glob match with pnpm/npm semantics for workspace patterns ("!" negates). */
function matchesWorkspace(dir: string, globs: readonly string[]): boolean {
  let matched = false;
  for (const raw of globs) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw)
      .replace(/^\.\//, "")
      .replace(/\/$/, "");
    if (path.posix.matchesGlob(dir, pattern)) matched = !negated;
  }
  return matched;
}

/**
 * detectProjectRoots for TS/JS: every tsconfig.json/jsconfig.json, every
 * package.json (with its name), and the workspace layout. Reads manifests as
 * data only; never runs anything.
 */
export function detectProjectRoots(repo: RepoView): ProjectRoot[] {
  const roots: ProjectRoot[] = [];
  const globs = workspaceGlobs(repo);
  if (globs)
    roots.push({
      kind: ROOT_KINDS.workspaceRoot,
      dir: "",
      file: "package.json",
    });
  for (const file of repo.files) {
    const base = baseOf(file);
    if (base === "tsconfig.json" || base === "jsconfig.json") {
      roots.push({ kind: ROOT_KINDS.tsconfig, dir: dirOf(file), file });
    } else if (base === "package.json") {
      const pkg = readJson(repo, file);
      const name =
        isRecord(pkg) && typeof pkg.name === "string" ? pkg.name : undefined;
      const dir = dirOf(file);
      const base = { dir, file, ...(name !== undefined ? { name } : {}) };
      roots.push({ kind: ROOT_KINDS.package, ...base });
      if (
        globs &&
        dir !== "" &&
        name !== undefined &&
        matchesWorkspace(dir, globs)
      ) {
        roots.push({ kind: ROOT_KINDS.workspacePackage, ...base });
      }
    }
  }
  return roots;
}
