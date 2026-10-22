import type { ProjectRoot, RepoView, ResolveContext } from "@epoch-dev/core";
import { isPackageFile, isTestFile } from "./files.js";
import { isDirectoryPath, parseModFile, type ModFile } from "./modfile.js";

/** Module files are capped like any config file; a larger one is ignored. */
const MAX_MODFILE_BYTES = 256 * 1024;

export const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Whether `s` is `prefix` or starts with `prefix/` (import paths and directories). */
export function hasPathPrefix(s: string, prefix: string): boolean {
  return prefix === "" || s === prefix || s.startsWith(`${prefix}/`);
}

/**
 * Joins a repo-relative directory and a relative path, resolving "." and
 * "..". Undefined when the result would leave the project folder.
 */
function joinDir(dir: string, rel: string): string | undefined {
  const parts = dir === "" ? [] : dir.split("/");
  for (const seg of rel.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join("/");
}

/** A rooted path (Unix or Windows), which always lies outside the project folder. */
const isRooted = (p: string): boolean =>
  p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p);

function readModFile(repo: RepoView, rel: string): ModFile | undefined {
  const text = repo.reader.readFile(`${repo.root}/${rel}`);
  return text !== undefined && text.length <= MAX_MODFILE_BYTES
    ? parseModFile(text)
    : undefined;
}

/** Every go.mod marks a module and every go.work a workspace (read, never run). */
export function detectProjectRoots(repo: RepoView): ProjectRoot[] {
  const roots: ProjectRoot[] = [];
  for (const file of repo.files) {
    const kind = baseOf(file);
    if (kind !== "go.mod" && kind !== "go.work") continue;
    const parsed = kind === "go.mod" ? readModFile(repo, file) : undefined;
    roots.push({
      kind,
      dir: dirOf(file),
      file,
      ...(kind === "go.mod" ? { package: true } : {}),
      ...(parsed?.module !== undefined ? { name: parsed.module } : {}),
    });
  }
  return roots;
}

/** A module that provides import paths from a directory in the project. */
export interface LocalModule {
  /** The import path prefix it provides. */
  readonly path: string;
  /** Repo-relative directory, or undefined when it lies outside the project. */
  readonly dir: string | undefined;
}

interface GoModule {
  readonly dir: string;
  /** Empty when the go.mod has no module directive. */
  readonly path: string;
  readonly file: ModFile;
}

interface Workspace {
  readonly dir: string;
  readonly uses: ReadonlySet<string>;
  readonly file: ModFile;
}

export interface ModuleIndex {
  /** The module a repo-relative file or directory belongs to (nearest go.mod). */
  moduleOf(path: string): GoModule | undefined;
  /** The import path of a repo-relative directory, from its module. */
  importPathOf(dir: string): string | undefined;
  /** Modules whose packages resolve inside the project, for code in `mod`. */
  localModules(mod: GoModule): readonly LocalModule[];
  /** Module paths `mod` requires (its workspace's, in a workspace). */
  requires(mod: GoModule): readonly string[];
  /** Directories with at least one production .go file. */
  readonly packageDirs: ReadonlySet<string>;
  /** Directories holding a go.mod. */
  readonly moduleDirs: ReadonlySet<string>;
}

const indexes = new WeakMap<ResolveContext, ModuleIndex>();

export function moduleIndex(ctx: ResolveContext): ModuleIndex {
  const cached = indexes.get(ctx);
  if (cached) return cached;
  const modules = new Map<string, GoModule>();
  const workspaces = new Map<string, Workspace>();
  for (const root of ctx.projectRoots) {
    if (root.file === undefined) continue;
    const file = readModFile(ctx.repo, root.file);
    if (file === undefined) continue;
    if (root.kind === "go.mod") {
      modules.set(root.dir, { dir: root.dir, path: file.module ?? "", file });
    } else if (root.kind === "go.work") {
      const uses = new Set<string>();
      for (const u of file.uses) {
        const d = isRooted(u) ? undefined : joinDir(root.dir, u);
        if (d !== undefined) uses.add(d);
      }
      workspaces.set(root.dir, { dir: root.dir, uses, file });
    }
  }
  const packageDirs = new Set<string>();
  for (const f of ctx.repo.files) {
    if (isPackageFile(f) && !isTestFile(f)) packageDirs.add(dirOf(f));
  }

  const nearest = <T>(
    map: ReadonlyMap<string, T>,
    path: string,
  ): T | undefined => {
    for (let d = path; ; d = dirOf(d)) {
      const hit = map.get(d);
      if (hit !== undefined) return hit;
      if (d === "") return undefined;
    }
  };
  const moduleOf = (path: string) => nearest(modules, path);
  const importPathOf = (dir: string): string | undefined => {
    const mod = moduleOf(dir);
    if (mod === undefined || mod.path === "") return undefined;
    const rel = mod.dir === "" ? dir : dir.slice(mod.dir.length + 1);
    return rel === "" ? mod.path : `${mod.path}/${rel}`;
  };
  /** The go.work governing a module: the nearest one above it, if it uses the module. */
  const workspaceOf = (mod: GoModule): Workspace | undefined => {
    const ws = nearest(workspaces, mod.dir);
    return ws?.uses.has(mod.dir) === true ? ws : undefined;
  };
  const replacements = (dir: string, file: ModFile): LocalModule[] =>
    file.replaces
      .filter((r) => isDirectoryPath(r.new))
      .map((r) => ({
        path: r.old,
        dir: isRooted(r.new) ? undefined : joinDir(dir, r.new),
      }));

  const index: ModuleIndex = {
    moduleOf,
    importPathOf,
    localModules(mod) {
      const ws = workspaceOf(mod);
      const used = ws
        ? [...ws.uses].flatMap((d) => {
            const m = modules.get(d);
            return m ? [m] : [];
          })
        : [mod];
      return [
        ...used
          .filter((m) => m.path !== "")
          .map((m) => ({ path: m.path, dir: m.dir })),
        ...(ws ? replacements(ws.dir, ws.file) : []),
        ...used.flatMap((m) => replacements(m.dir, m.file)),
      ];
    },
    requires(mod) {
      const ws = workspaceOf(mod);
      const used = ws
        ? [...ws.uses].flatMap((d) => modules.get(d)?.file.requires ?? [])
        : mod.file.requires;
      return used;
    },
    packageDirs,
    moduleDirs: new Set(modules.keys()),
  };
  indexes.set(ctx, index);
  return index;
}

/**
 * The package node a file belongs to (ADR-013): production files are
 * members of `pkg:<import path>`; test files are linked to it. Files with no
 * module above them have no import path and stay file nodes.
 */
export function packageFor(
  path: string,
  ctx: ResolveContext,
): { id: string; member: boolean } | undefined {
  if (!isPackageFile(path)) return undefined;
  const importPath = moduleIndex(ctx).importPathOf(dirOf(path));
  return importPath === undefined
    ? undefined
    : { id: `pkg:${importPath}`, member: !isTestFile(path) };
}
