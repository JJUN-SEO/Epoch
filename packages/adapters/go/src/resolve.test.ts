import { describe, expect, it } from "vitest";
import type { RawImport, RepoView, ResolveContext } from "@epoch-dev/core";
import { detectProjectRoots, packageFor } from "./modules.js";
import { isStandardImportPath, resolveImport } from "./resolve.js";

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

const imp = (specifier: string | null): RawImport => ({
  kind: "static",
  specifier,
  typeOnly: false,
  names: [{ imported: "*" }],
  line: 1,
});

describe("resolveImport", () => {
  it("reports a replace directory outside the project folder", () => {
    const ctx = repo({
      "go.mod":
        "module example.com/app\n\nrequire example.com/lib v1.0.0\n\nreplace example.com/lib => ../lib\n",
      "main.go": "package main\n",
    });
    expect(resolveImport(imp("example.com/lib/x"), "main.go", ctx)).toEqual({
      kind: "unresolved",
      reason: "outside-project",
    });
    expect(resolveImport(imp("example.com/other"), "main.go", ctx)).toEqual({
      kind: "external",
      name: "example.com/other",
    });
  });

  it("resolves a module whose path has no dot before the standard-library rule", () => {
    const ctx = repo({
      "go.mod": "module myapp\n",
      "main.go": "package main\n",
      "util/u.go": "package util\n",
    });
    expect(resolveImport(imp("myapp/util"), "main.go", ctx)).toEqual({
      kind: "package",
      target: "pkg:myapp/util",
    });
    expect(resolveImport(imp("myapp/none"), "main.go", ctx)).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
    expect(resolveImport(imp("strings"), "main.go", ctx)).toEqual({
      kind: "external",
      name: "go:strings",
    });
  });

  it("gives files no import path when go.mod has no module directive", () => {
    const ctx = repo({ "a/a.go": "package a\n", "go.mod": "go 1.22\n" });
    expect(packageFor("a/a.go", ctx)).toBeUndefined();
  });

  it("leaves non-literal and rooted specifiers unresolved", () => {
    const ctx = repo({ "go.mod": "module m.com/x\n", "a.go": "package x\n" });
    for (const spec of [null, "/abs/x", ".", "../up"]) {
      expect(resolveImport(imp(spec), "a.go", ctx)).toEqual({
        kind: "unresolved",
        reason: "unsupported-syntax",
      });
    }
  });
});

describe("packageFor", () => {
  it("maps production files to their package and test files to a link", () => {
    const ctx = repo({
      "go.mod": "module example.com/m\n",
      "a/a.go": "package a\n",
      "a/a_test.go": "package a\n",
      "sub/go.mod": "module example.com/sub\n",
      "sub/s.go": "package sub\n",
      "vendor/v/v.go": "package v\n",
    });
    expect(packageFor("a/a.go", ctx)).toEqual({
      id: "pkg:example.com/m/a",
      member: true,
    });
    expect(packageFor("a/a_test.go", ctx)).toEqual({
      id: "pkg:example.com/m/a",
      member: false,
    });
    expect(packageFor("sub/s.go", ctx)).toEqual({
      id: "pkg:example.com/sub",
      member: true,
    });
    expect(packageFor("vendor/v/v.go", ctx)).toBeUndefined();
  });
});

describe("isStandardImportPath", () => {
  it("is true when the first element has no dot", () => {
    expect(isStandardImportPath("net/http")).toBe(true);
    expect(isStandardImportPath("fmt")).toBe(true);
    expect(isStandardImportPath("github.com/x/y")).toBe(false);
    expect(isStandardImportPath("gopkg.in/yaml.v3")).toBe(false);
  });
});
