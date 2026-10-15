import { parse as parseToml } from "smol-toml";
import type { ProjectRoot, RepoView } from "@epoch-dev/core";

/** Config files that mark a Python project's directory. */
export const ROOT_KINDS = ["pyproject.toml", "setup.cfg", "setup.py"] as const;

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const join = (...parts: string[]): string =>
  parts
    .filter((p) => p !== "" && p !== ".")
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

/** Config files are capped like any source file; a larger one is ignored. */
const MAX_CONFIG_BYTES = 256 * 1024;

function readConfig(repo: RepoView, rel: string): string | undefined {
  const text = repo.reader.readFile(`${repo.root}/${rel}`);
  return text !== undefined && text.length <= MAX_CONFIG_BYTES
    ? text
    : undefined;
}

type Table = Readonly<Record<string, unknown>>;

const isTable = (v: unknown): v is Table =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function at(v: unknown, ...keys: string[]): unknown {
  let cur = v;
  for (const k of keys) cur = isTable(cur) ? cur[k] : undefined;
  return cur;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** pyproject.toml as data (smol-toml); undefined if it does not parse. */
function pyproject(repo: RepoView, rel: string): Table | undefined {
  const text = readConfig(repo, rel);
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = parseToml(text);
    return isTable(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every pyproject.toml, setup.cfg and setup.py marks a project (setup.py is never run). */
export function detectProjectRoots(repo: RepoView): ProjectRoot[] {
  const roots: ProjectRoot[] = [];
  for (const file of repo.files) {
    const kind = baseOf(file);
    if (!(ROOT_KINDS as readonly string[]).includes(kind)) continue;
    let name: string | undefined;
    if (kind === "pyproject.toml") {
      const doc = pyproject(repo, file);
      const n = at(doc, "project", "name") ?? at(doc, "tool", "poetry", "name");
      if (typeof n === "string") name = n;
    }
    roots.push({ kind, dir: dirOf(file), file, ...(name ? { name } : {}) });
  }
  return roots;
}

/**
 * Source directories a project declares, relative to the repo:
 * setuptools `package-dir` ("" key) and `packages.find.where`, poetry
 * `packages[].from`, hatch wheel `packages`, pdm `package-dir`, and
 * setup.cfg `[options] package_dir = =src`.
 */
export function declaredSourceDirs(
  repo: RepoView,
  root: ProjectRoot,
): string[] {
  const dirs: string[] = [];
  if (root.kind === "pyproject.toml" && root.file !== undefined) {
    const doc = pyproject(repo, root.file);
    const setuptools = at(doc, "tool", "setuptools");
    const packageDir = at(setuptools, "package-dir", "");
    if (typeof packageDir === "string") dirs.push(packageDir);
    dirs.push(...strings(at(setuptools, "packages", "find", "where")));
    const poetry = at(doc, "tool", "poetry", "packages");
    if (Array.isArray(poetry)) {
      for (const p of poetry) {
        const from = at(p, "from");
        if (typeof from === "string") dirs.push(from);
      }
    }
    for (const pkg of strings(
      at(doc, "tool", "hatch", "build", "targets", "wheel", "packages"),
    )) {
      dirs.push(dirOf(pkg));
    }
    const pdm = at(doc, "tool", "pdm", "build", "package-dir");
    if (typeof pdm === "string") dirs.push(pdm);
  }
  if (root.kind === "setup.cfg" && root.file !== undefined) {
    const text = readConfig(repo, root.file) ?? "";
    const m = /^\s*package_dir\s*=\s*(?:\n\s+)?=\s*(\S+)\s*$/m.exec(text);
    if (m?.[1] !== undefined) dirs.push(m[1]);
  }
  return dirs
    .filter((d) => !d.startsWith("/") && !d.split("/").includes(".."))
    .map((d) => join(root.dir, d));
}

export interface ProjectSources {
  /** The project's directory ("" for the repository root). */
  readonly dir: string;
  /** Its sys.path-like entries, in order. */
  readonly roots: readonly string[];
}

const depth = (dir: string): number => (dir === "" ? 0 : dir.split("/").length);

/**
 * Each project's directories that act as entries on sys.path: its declared
 * source directories, then a src/ layout directory (one that is not itself a
 * package), then the project directory. The repository root is always a
 * project. Deepest projects come first.
 */
export function projectSources(
  repo: RepoView,
  projectRoots: readonly ProjectRoot[],
  isDir: (rel: string) => boolean,
  isFile: (rel: string) => boolean,
): ProjectSources[] {
  const byDir = new Map<string, string[]>();
  const projects = [...projectRoots];
  if (!projects.some((p) => p.dir === ""))
    projects.push({ kind: "repo", dir: "" });
  for (const p of projects) {
    const roots = byDir.get(p.dir) ?? [];
    const add = (d: string) => {
      if (!roots.includes(d) && (d === "" || isDir(d))) roots.push(d);
    };
    for (const d of declaredSourceDirs(repo, p)) add(d);
    const src = join(p.dir, "src");
    if (isDir(src) && !isFile(join(src, "__init__.py"))) add(src);
    byDir.set(p.dir, roots);
  }
  return [...byDir.entries()]
    .map(([dir, roots]) => ({
      dir,
      roots: [...roots, ...(roots.includes(dir) ? [] : [dir])],
    }))
    .sort((a, b) => depth(b.dir) - depth(a.dir) || (a.dir < b.dir ? -1 : 1));
}
