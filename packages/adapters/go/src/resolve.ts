import type { RawImport, Resolution, ResolveContext } from "@epoch-dev/core";
import { dirOf, hasPathPrefix, moduleIndex } from "./modules.js";

/*
 * Resolution from the go command's rules, over files read as data
 * (ADR-013, ADR-006: never by running the go command). Local modules (the
 * importer's module, its go.work's modules, and directory replacements)
 * provide packages from their directories; the standard library and
 * third-party modules are externals.
 */

const unresolved = (
  reason: "not-found" | "unsupported-syntax" | "outside-project",
): Resolution => ({ kind: "unresolved", reason });

/** search.IsStandardImportPath: a first path element without a dot. */
export function isStandardImportPath(path: string): boolean {
  const slash = path.indexOf("/");
  return !(slash < 0 ? path : path.slice(0, slash)).includes(".");
}

/**
 * The import path code must be inside to import `path`, which contains an
 * `internal` element: the parent of its last one ("" for none needed).
 * Undefined when the path has no internal element (load.findInternal).
 */
function internalParent(path: string): string | undefined {
  if (path.endsWith("/internal")) return path.slice(0, -"/internal".length);
  const i = path.lastIndexOf("/internal/");
  if (i >= 0) return path.slice(0, i);
  if (path === "internal" || path.startsWith("internal/")) return "";
  return undefined;
}

export function resolveImport(
  imp: RawImport,
  from: string,
  ctx: ResolveContext,
): Resolution {
  const spec = imp.specifier;
  if (spec === null) return unresolved("unsupported-syntax");
  if (spec === "C") return { kind: "external", name: "cgo" };
  if (
    spec === "." ||
    spec === ".." ||
    spec.startsWith("./") ||
    spec.startsWith("../") ||
    spec.startsWith("/")
  ) {
    return unresolved("unsupported-syntax");
  }

  const ix = moduleIndex(ctx);
  const mod = ix.moduleOf(dirOf(from));
  if (mod !== undefined) {
    // The longest local module path first; a nested go.mod on the way means
    // that module does not provide the package (modload.dirInModule).
    const locals = [...ix.localModules(mod)].sort(
      (a, b) => b.path.length - a.path.length,
    );
    let provided = false;
    for (const local of locals) {
      if (!hasPathPrefix(spec, local.path)) continue;
      if (local.dir === undefined) return unresolved("outside-project");
      const rest = spec.slice(local.path.length + 1);
      const dir =
        rest === ""
          ? local.dir
          : local.dir === ""
            ? rest
            : `${local.dir}/${rest}`;
      let nested = false;
      for (let d = dir; d !== local.dir && d !== ""; d = dirOf(d)) {
        if (ix.moduleDirs.has(d)) nested = true;
      }
      if (nested) continue;
      provided = true;
      if (!ix.packageDirs.has(dir)) continue;
      const target = ix.importPathOf(dir);
      if (target === undefined) continue;
      const parent = internalParent(spec);
      const importer = ix.importPathOf(dirOf(from));
      if (
        parent !== undefined &&
        (importer === undefined || !hasPathPrefix(importer, parent))
      ) {
        return unresolved("not-found"); // the go tool refuses it
      }
      return { kind: "package", target: `pkg:${target}` };
    }
    if (provided) return unresolved("not-found");
  }

  if (isStandardImportPath(spec))
    return { kind: "external", name: `go:${spec}` };
  let name = spec;
  let best = -1;
  for (const req of mod ? ix.requires(mod) : []) {
    if (hasPathPrefix(spec, req) && req.length > best) {
      name = req;
      best = req.length;
    }
  }
  return { kind: "external", name };
}
