import type { RawImport, Resolution, ResolveContext } from "@epoch-dev/core";
import { projectSources, type ProjectSources } from "./roots.js";
import { STDLIB_MODULES } from "./stdlib.generated.js";

/*
 * Resolution from Python's import system rules, over the discovered files
 * (ADR-006: never by asking an interpreter). Source roots stand in for
 * sys.path; regular packages win over namespace packages, and the standard
 * library is a bundled list.
 */

interface Index {
  readonly files: ReadonlySet<string>;
  /** Directories with a .py or .pyi file somewhere beneath (namespace package candidates). */
  readonly pyDirs: ReadonlySet<string>;
  readonly projects: readonly ProjectSources[];
  /** Every source root, deepest first. */
  readonly roots: readonly string[];
}

const indexes = new WeakMap<ResolveContext, Index>();

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const join = (...parts: string[]): string =>
  parts.filter((p) => p !== "").join("/");
const depth = (dir: string): number => (dir === "" ? 0 : dir.split("/").length);
const inside = (path: string, dir: string): boolean =>
  dir === "" || path === dir || path.startsWith(`${dir}/`);

function indexFor(ctx: ResolveContext): Index {
  const cached = indexes.get(ctx);
  if (cached) return cached;
  const files = new Set(ctx.repo.files);
  const dirs = new Set<string>();
  const pyDirs = new Set<string>();
  for (const f of files) {
    const py = /\.pyi?$/.test(f);
    for (let d = dirOf(f); d !== ""; d = dirOf(d)) {
      const seen = dirs.has(d) && (!py || pyDirs.has(d));
      dirs.add(d);
      if (py) pyDirs.add(d);
      if (seen) break;
    }
  }
  const projects = projectSources(
    ctx.repo,
    ctx.projectRoots,
    (d) => dirs.has(d),
    (f) => files.has(f),
  );
  const roots = [...new Set(projects.flatMap((p) => p.roots))].sort(
    (a, b) => depth(b) - depth(a),
  );
  const index = { files, pyDirs, projects, roots };
  indexes.set(ctx, index);
  return index;
}

/** sys.path order for a file: the projects that contain it (deepest first), then the others. */
function rootsFor(ix: Index, from: string): string[] {
  const mine = ix.projects.filter((p) => inside(from, p.dir));
  const others = ix.projects.filter((p) => !mine.includes(p));
  return [...new Set([...mine, ...others].flatMap((p) => p.roots))];
}

/** The file Python loads for module path `p`: a package before a module, stubs last. */
function moduleFile(ix: Index, p: string): string | undefined {
  if (p === "") return undefined;
  for (const c of [
    `${p}/__init__.py`,
    `${p}.py`,
    `${p}/__init__.pyi`,
    `${p}.pyi`,
  ]) {
    if (ix.files.has(c)) return c;
  }
  return undefined;
}

const file = (target: string): Resolution => ({ kind: "file", target });
const notFound: Resolution = { kind: "unresolved", reason: "not-found" };

/** The name a from-import asks for, when it might be a submodule. */
function importedName(imp: RawImport): string | undefined {
  if (imp.kind === "dynamic" || imp.names.length !== 1) return undefined;
  const name = imp.names[0]?.imported;
  return name === undefined || name === "*" ? undefined : name;
}

/**
 * The package directory a relative import with `level` dots starts from, or
 * undefined when it climbs above the top-level package (Python raises
 * "attempted relative import beyond top-level package").
 */
function relativeBase(
  ix: Index,
  from: string,
  level: number,
): string | undefined {
  const dir = dirOf(from);
  const root = ix.roots.find((r) => inside(dir, r)) ?? "";
  const parts =
    dir === root ? [] : dir.slice(root === "" ? 0 : root.length + 1).split("/");
  if (level - 1 >= parts.length) return undefined;
  return join(root, parts.slice(0, parts.length - (level - 1)).join("/"));
}

function resolveRelative(
  ix: Index,
  spec: string,
  name: string | undefined,
  from: string,
): Resolution {
  const level = /^\.+/.exec(spec)?.[0].length ?? 0;
  const base = relativeBase(ix, from, level);
  if (base === undefined) return notFound;
  const rest = spec.slice(level);
  const path = rest === "" ? base : join(base, rest.split(".").join("/"));
  if (name !== undefined) {
    const sub = moduleFile(ix, join(path, name));
    if (sub) return file(sub);
  }
  const target = moduleFile(ix, path);
  return target ? file(target) : notFound;
}

function resolveAbsolute(
  ix: Index,
  spec: string,
  name: string | undefined,
  from: string,
): Resolution {
  const parts = spec.split(".");
  const top = parts[0] ?? "";
  const roots = rootsFor(ix, from);
  // Regular modules and packages, in sys.path order. `import a.b.c` links the
  // deepest module that exists, as grimp does; parent __init__ files are not
  // linked separately.
  for (const r of roots) {
    if (name !== undefined) {
      const sub = moduleFile(ix, join(r, ...parts, name));
      if (sub) return file(sub);
    }
    if (moduleFile(ix, join(r, top)) === undefined) continue;
    for (let i = parts.length; i >= 1; i--) {
      const target = moduleFile(ix, join(r, ...parts.slice(0, i)));
      if (target) return file(target);
    }
  }
  // A regular module later on sys.path (the standard library) beats a
  // namespace package portion.
  if (STDLIB_MODULES.has(top)) return { kind: "external", name: `py:${top}` };
  for (const r of roots) {
    if (!ix.pyDirs.has(join(r, top))) continue;
    for (let i = parts.length; i >= 2; i--) {
      const target = moduleFile(ix, join(r, ...parts.slice(0, i)));
      if (target) return file(target);
    }
    // A namespace package itself has no file to link.
    return name === undefined && ix.pyDirs.has(join(r, ...parts))
      ? { kind: "unresolved", reason: "ambiguous" }
      : notFound;
  }
  return { kind: "external", name: top };
}

/** Where a dynamic import with a literal module prefix ("plugins.") may load from. */
function prefixPath(
  ix: Index,
  prefix: string,
  from: string,
): string | undefined {
  const level = /^\.+/.exec(prefix)?.[0].length ?? 0;
  const parts = prefix.slice(level).split(".");
  const partial = parts.pop() ?? "";
  if (level > 0) {
    const base = relativeBase(ix, from, level);
    return base === undefined
      ? undefined
      : `${join(base, ...parts)}/${partial}`;
  }
  if (parts.length === 0) return undefined;
  for (const r of rootsFor(ix, from)) {
    const dir = join(r, ...parts);
    if (ix.pyDirs.has(dir)) return `${dir}/${partial}`;
  }
  return undefined;
}

export function resolveImport(
  imp: RawImport,
  from: string,
  ctx: ResolveContext,
): Resolution {
  const ix = indexFor(ctx);
  if (imp.specifier === null) {
    const path =
      imp.dynamicPrefix === undefined
        ? undefined
        : prefixPath(ix, imp.dynamicPrefix, from);
    return {
      kind: "unresolved",
      reason: "dynamic-specifier",
      ...(path === undefined ? {} : { pathPrefix: path }),
    };
  }
  const name = importedName(imp);
  return imp.specifier.startsWith(".")
    ? resolveRelative(ix, imp.specifier, name, from)
    : resolveAbsolute(ix, imp.specifier, name, from);
}
