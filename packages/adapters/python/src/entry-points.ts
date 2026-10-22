import type { EntryPoint, ProjectContext } from "@epoch-dev/core";
import { isTestFile } from "./files.js";
import {
  at,
  isTable,
  projectSources,
  pyproject,
  readConfig,
  type Table,
} from "./roots.js";

/*
 * Entry points for Python (CLAUDE.md "Unreachable files", ADR-007):
 * `__main__.py`, files with an `if __name__ == "__main__":` guard or a `#!`
 * line, manage.py/wsgi.py/asgi.py, tool configuration files (Sphinx's
 * conf.py, noxfile.py, setup.py), scripts and entry points declared in
 * pyproject.toml and setup.cfg, and the public modules of distributable
 * packages (a library's public API is reachable by definition). Config files
 * are read as data and source files as text; setup.py is never run or parsed.
 */

const dirOf = (p: string): string =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const baseOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const join = (...parts: string[]): string =>
  parts.filter((p) => p !== "").join("/");
const inside = (path: string, dir: string): boolean =>
  dir === "" || path.startsWith(`${dir}/`);

const CONVENTION_NAMES = new Set([
  "__main__.py",
  "manage.py",
  "wsgi.py",
  "asgi.py",
]);

/** Files tools load by name: Sphinx's conf.py, nox's noxfile.py, setuptools' setup.py. */
const CONFIG_NAMES = new Set(["conf.py", "noxfile.py", "setup.py"]);

/** A `__name__ == "__main__"` guard, by fixed-string search (no regex over the file). */
function hasMainGuard(text: string): boolean {
  return (
    text.includes("__name__") &&
    (text.includes('"__main__"') || text.includes("'__main__'"))
  );
}

/** The module of an entry-point reference "pkg.mod:attr [extra]", or undefined. */
export function referenceModule(ref: string): string | undefined {
  const m = /^\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*(?::|\[|$)/.exec(
    ref,
  );
  return m?.[1]?.replace(/\s+/g, "");
}

interface Declared {
  readonly module?: string;
  /** A script file path, relative to the project directory. */
  readonly file?: string;
  readonly source: string;
}

/** Scripts and entry points a pyproject.toml declares. */
function pyprojectEntries(doc: Table, file: string): Declared[] {
  const out: Declared[] = [];
  const table = (v: unknown, label: string) => {
    if (!isTable(v)) return;
    for (const [name, ref] of Object.entries(v)) {
      const source = `${file} ${label} ${name}`;
      if (typeof ref === "string") {
        const module = referenceModule(ref);
        if (module !== undefined) out.push({ module, source });
        continue;
      }
      // Poetry tables: { callable = "pkg:fn" } or { reference = "bin/x", type = "file" }.
      const callable = at(ref, "callable");
      const reference = at(ref, "reference");
      if (typeof callable === "string") {
        const module = referenceModule(callable);
        if (module !== undefined) out.push({ module, source });
      } else if (typeof reference === "string" && at(ref, "type") === "file") {
        out.push({ file: reference, source });
      }
    }
  };
  const groups = (v: unknown, label: string) => {
    if (!isTable(v)) return;
    for (const [group, t] of Object.entries(v)) table(t, `[${label}.${group}]`);
  };
  table(at(doc, "project", "scripts"), "[project.scripts]");
  table(at(doc, "project", "gui-scripts"), "[project.gui-scripts]");
  groups(at(doc, "project", "entry-points"), "project.entry-points");
  table(at(doc, "tool", "poetry", "scripts"), "[tool.poetry.scripts]");
  groups(at(doc, "tool", "poetry", "plugins"), "tool.poetry.plugins");
  return out;
}

/** Entry points in setup.cfg's `[options.entry_points]` section, read line by line. */
function setupCfgEntries(text: string, file: string): Declared[] {
  const out: Declared[] = [];
  let inSection = false;
  let group = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inSection = line === "[options.entry_points]";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    const indented = raw.startsWith(" ") || raw.startsWith("\t");
    if (!indented) {
      if (eq === -1) continue;
      group = line.slice(0, eq).trim();
      const rest = line.slice(eq + 1).trim();
      if (rest === "") continue;
      // `group = name = pkg:fn` on one line
      const inner = rest.indexOf("=");
      if (inner === -1) continue;
      const module = referenceModule(rest.slice(inner + 1));
      if (module !== undefined)
        out.push({ module, source: `${file} ${group}` });
    } else if (eq !== -1) {
      const module = referenceModule(line.slice(eq + 1));
      const name = line.slice(0, eq).trim();
      if (module !== undefined)
        out.push({ module, source: `${file} ${group} ${name}` });
    }
  }
  return out;
}

export function detectEntryPoints(ctx: ProjectContext): EntryPoint[] {
  const { repo } = ctx;
  const files = new Set(repo.files);
  const dirs = new Set<string>();
  for (const f of repo.files) {
    for (let d = dirOf(f); d !== "" && !dirs.has(d); d = dirOf(d)) dirs.add(d);
  }
  const projects = projectSources(
    repo,
    ctx.projectRoots,
    (d) => dirs.has(d),
    (f) => files.has(f),
  );
  const rootsOf = (dir: string) =>
    projects.find((p) => p.dir === dir)?.roots ?? [dir];
  const moduleFile = (roots: readonly string[], module: string) => {
    const p = module.split(".").join("/");
    for (const r of roots) {
      for (const c of [join(r, p, "__init__.py"), `${join(r, p)}.py`]) {
        if (files.has(c)) return c;
      }
    }
    return undefined;
  };

  const out: EntryPoint[] = [];
  const add = (file: string, reason: EntryPoint["reason"], source: string) => {
    if (files.has(file) && file.endsWith(".py"))
      out.push({ file, reason, source });
  };

  /** Project directory -> the config file that makes it distributable. */
  const distributable = new Map<string, string>();
  for (const root of ctx.projectRoots) {
    if (root.file === undefined) continue;
    let declared: Declared[] = [];
    if (root.kind === "pyproject.toml") {
      const doc = pyproject(repo, root.file);
      if (doc === undefined) continue;
      declared = pyprojectEntries(doc, root.file);
      // Built and installed only with a build system (and not poetry's package-mode = false).
      if (
        isTable(at(doc, "build-system")) &&
        at(doc, "tool", "poetry", "package-mode") !== false
      ) {
        distributable.set(root.dir, root.file);
      }
    } else if (root.kind === "setup.cfg") {
      declared = setupCfgEntries(readConfig(repo, root.file) ?? "", root.file);
      distributable.set(root.dir, root.file);
    } else if (root.kind === "setup.py") {
      distributable.set(root.dir, root.file);
    }
    for (const d of declared) {
      const file =
        d.module !== undefined
          ? moduleFile(rootsOf(root.dir), d.module)
          : d.file !== undefined
            ? join(root.dir, d.file)
            : undefined;
      if (file !== undefined) add(file, "manifest", d.source);
    }
  }

  // Public modules of distributable packages: every module reachable through
  // regular packages from a source root, with no path segment starting "_".
  for (const [dir, manifest] of [...distributable].sort(([a], [b]) =>
    a < b ? -1 : 1,
  )) {
    const roots = rootsOf(dir);
    for (const f of repo.files) {
      if (!f.endsWith(".py") || !inside(f, dir) || isTestFile(f)) continue;
      const root = roots.find((r) => inside(f, r));
      if (root === undefined) continue;
      const rel = root === "" ? f : f.slice(root.length + 1);
      const parts = rel.split("/");
      const name = (parts.pop() ?? "").replace(/\.py$/, "");
      if (name !== "__init__" && name.startsWith("_")) continue;
      if (parts.some((p) => p.startsWith("_") || !/^[A-Za-z_]\w*$/.test(p)))
        continue;
      let regular = true;
      for (let i = 1; i <= parts.length; i++) {
        if (!files.has(join(root, ...parts.slice(0, i), "__init__.py")))
          regular = false;
      }
      if (!regular || (parts.length === 0 && name === "__init__")) continue;
      const module = [...parts, ...(name === "__init__" ? [] : [name])].join(
        ".",
      );
      add(f, "manifest", `${manifest} (public module ${module})`);
    }
  }

  for (const f of repo.files) {
    if (!f.endsWith(".py")) continue;
    const base = baseOf(f);
    if (CONVENTION_NAMES.has(base)) {
      add(f, "convention", `${base} (entry-point name)`);
      continue;
    }
    if (CONFIG_NAMES.has(base)) {
      add(f, "config", `${base} (tool configuration)`);
      continue;
    }
    const text = repo.reader.readFile(`${repo.root}/${f}`);
    if (text?.startsWith("#!") === true) {
      add(f, "convention", "executable script (#!)");
    } else if (text !== undefined && hasMainGuard(text)) {
      add(f, "convention", 'if __name__ == "__main__"');
    }
  }
  return out;
}
