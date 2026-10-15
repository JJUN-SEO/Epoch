import { describe, expect, it } from "vitest";
import type {
  RawImport,
  RepoView,
  Resolution,
  ResolveContext,
} from "@epoch-dev/core";
import { resolveImport } from "./resolve.js";
import { detectProjectRoots } from "./roots.js";

/** An in-memory project: repo-relative path -> content. */
function repo(files: Readonly<Record<string, string>>): ResolveContext {
  const root = "/repo";
  const rel = (p: string) => p.slice(root.length + 1);
  const view: RepoView = {
    root,
    files: Object.keys(files).sort(),
    reader: {
      readFile: (p) => files[rel(p)],
      fileExists: (p) => rel(p) in files,
      directoryExists: (p) =>
        Object.keys(files).some((f) => f.startsWith(`${rel(p)}/`)),
      getDirectories: () => [],
      realpath: (p) => p,
    },
  };
  return { repo: view, projectRoots: detectProjectRoots(view) };
}

const imp = (
  specifier: string | null,
  name = "*",
  extra: Partial<RawImport> = {},
): RawImport => ({
  kind: "static",
  specifier,
  typeOnly: false,
  names: [{ imported: name }],
  line: 1,
  ...extra,
});

const resolve = (ctx: ResolveContext, from: string, i: RawImport): Resolution =>
  resolveImport(i, from, ctx);

describe("source roots from project configuration", () => {
  it.each([
    [
      "poetry packages[].from",
      '[tool.poetry]\nname = "x"\npackages = [{ include = "pkg", from = "lib" }]\n',
    ],
    [
      "setuptools packages.find.where",
      '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
    ],
    [
      "hatch wheel packages",
      '[tool.hatch.build.targets.wheel]\npackages = ["lib/pkg"]\n',
    ],
    ["pdm package-dir", '[tool.pdm.build]\npackage-dir = "lib"\n'],
  ])("reads %s", (_name, toml) => {
    const ctx = repo({
      "pyproject.toml": toml,
      "lib/pkg/__init__.py": "",
      "lib/pkg/m.py": "",
      "app.py": "",
    });
    expect(resolve(ctx, "app.py", imp("pkg.m"))).toEqual({
      kind: "file",
      target: "lib/pkg/m.py",
    });
  });

  it("reads setup.cfg package_dir, on one line or the next", () => {
    for (const cfg of [
      "[options]\npackage_dir = =lib\n",
      "[options]\npackage_dir =\n    =lib\n",
    ]) {
      const ctx = repo({
        "setup.cfg": cfg,
        "lib/pkg/__init__.py": "",
        "app.py": "",
      });
      expect(resolve(ctx, "app.py", imp("pkg"))).toEqual({
        kind: "file",
        target: "lib/pkg/__init__.py",
      });
    }
  });

  it("ignores declared directories that leave the project or do not parse", () => {
    const ctx = repo({
      "pyproject.toml": '[tool.setuptools.package-dir]\n"" = "../outside"\n',
      "sub/pyproject.toml": "this is [ not toml",
      "app.py": "",
    });
    expect(resolve(ctx, "app.py", imp("pkg"))).toEqual({
      kind: "external",
      name: "pkg",
    });
  });

  it("prefers the importing file's own project in a monorepo", () => {
    const ctx = repo({
      "a/pyproject.toml": '[project]\nname = "a"\n',
      "a/src/common/__init__.py": "",
      "a/src/app.py": "",
      "b/pyproject.toml": '[project]\nname = "b"\n',
      "b/src/common/__init__.py": "",
      "b/src/app.py": "",
    });
    expect(resolve(ctx, "a/src/app.py", imp("common"))).toEqual({
      kind: "file",
      target: "a/src/common/__init__.py",
    });
    expect(resolve(ctx, "b/src/app.py", imp("common"))).toEqual({
      kind: "file",
      target: "b/src/common/__init__.py",
    });
  });

  it("names the project in detectProjectRoots", () => {
    const ctx = repo({
      "pyproject.toml": '[project]\nname = "demo"\n',
      "tools/setup.py": "",
    });
    expect(ctx.projectRoots).toEqual([
      { kind: "pyproject.toml", dir: "", file: "pyproject.toml", name: "demo" },
      { kind: "setup.py", dir: "tools", file: "tools/setup.py" },
    ]);
  });
});

describe("module lookup", () => {
  it("prefers a package over a module of the same name, and stubs last", () => {
    const ctx = repo({
      "m/__init__.py": "",
      "m.py": "",
      "s.pyi": "",
      "app.py": "",
    });
    expect(resolve(ctx, "app.py", imp("m"))).toEqual({
      kind: "file",
      target: "m/__init__.py",
    });
    expect(resolve(ctx, "app.py", imp("s"))).toEqual({
      kind: "file",
      target: "s.pyi",
    });
  });

  it("lets a project module shadow the standard library, but not a namespace directory", () => {
    const ctx = repo({
      "logging.py": "",
      "email/notes.txt": "",
      "json/data.py": "",
      "app.py": "",
    });
    expect(resolve(ctx, "app.py", imp("logging"))).toEqual({
      kind: "file",
      target: "logging.py",
    });
    expect(resolve(ctx, "app.py", imp("email"))).toEqual({
      kind: "external",
      name: "py:email",
    });
    expect(resolve(ctx, "app.py", imp("json"))).toEqual({
      kind: "external",
      name: "py:json",
    });
  });

  it("links the deepest existing module of a missing submodule", () => {
    const ctx = repo({ "pkg/__init__.py": "", "app.py": "" });
    expect(resolve(ctx, "app.py", imp("pkg.missing.deeper"))).toEqual({
      kind: "file",
      target: "pkg/__init__.py",
    });
  });

  it("reports a missing relative module and a name missing from a namespace package", () => {
    const ctx = repo({ "pkg/__init__.py": "", "pkg/a.py": "", "ns/x.py": "" });
    expect(resolve(ctx, "pkg/a.py", imp(".missing", "n"))).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
    expect(resolve(ctx, "pkg/a.py", imp("ns", "nope"))).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
  });

  it("resolves relative imports from an __init__.py against its own package", () => {
    const ctx = repo({ "pkg/__init__.py": "", "pkg/core.py": "" });
    expect(resolve(ctx, "pkg/__init__.py", imp(".core", "X"))).toEqual({
      kind: "file",
      target: "pkg/core.py",
    });
  });

  it("refuses a relative import from a top-level module", () => {
    const ctx = repo({ "app.py": "", "sib.py": "" });
    expect(resolve(ctx, "app.py", imp(".", "sib"))).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
  });

  it("gives a dynamic prefix a path prefix when its package exists", () => {
    const ctx = repo({
      "plugins/a.py": "",
      "pkg/__init__.py": "",
      "pkg/m.py": "",
    });
    const dyn = (prefix: string, from = "app.py") =>
      resolve(
        ctx,
        from,
        imp(null, "*", { kind: "dynamic", names: [], dynamicPrefix: prefix }),
      );
    expect(dyn("plugins.")).toEqual({
      kind: "unresolved",
      reason: "dynamic-specifier",
      pathPrefix: "plugins/",
    });
    expect(dyn("plugins.a_")).toMatchObject({ pathPrefix: "plugins/a_" });
    expect(dyn(".", "pkg/m.py")).toMatchObject({ pathPrefix: "pkg/" });
    expect(dyn("nothing.")).toEqual({
      kind: "unresolved",
      reason: "dynamic-specifier",
    });
  });
});
