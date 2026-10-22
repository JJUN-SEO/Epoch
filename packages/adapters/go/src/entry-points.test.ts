import { describe, expect, it } from "vitest";
import type { ProjectContext, RepoView } from "@epoch-dev/core";
import { detectEntryPoints, packageClause } from "./entry-points.js";
import { detectProjectRoots } from "./modules.js";

/** An in-memory project: repo-relative path -> content. */
function project(files: Readonly<Record<string, string>>): ProjectContext {
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

describe("go entry points", () => {
  it("finds package main and every importable package, not internal ones", () => {
    const ctx = project({
      "go.mod": "module example.com/m\n\ngo 1.22\n",
      "cmd/tool/main.go": "// Command tool.\npackage main\n",
      "cmd/tool/flags.go": "package main\n",
      "lib.go": "package m\n",
      "pkg/a/a.go": "package a\n",
      "pkg/a/a_test.go": "package a\n",
      "internal/x/x.go": "package x\n",
      "pkg/internal/y/y.go": "package y\n",
      "testdata/t.go": "package t\n",
    });
    expect(
      detectEntryPoints(ctx).map((e) => [e.file, e.reason, e.source]),
    ).toEqual([
      ["lib.go", "manifest", "go.mod (importable package example.com/m)"],
      ["cmd/tool/flags.go", "convention", "package main"],
      [
        "pkg/a/a.go",
        "manifest",
        "go.mod (importable package example.com/m/pkg/a)",
      ],
    ]);
  });

  it("names a nested module's go.mod, and treats files outside modules one by one", () => {
    const ctx = project({
      "tools/go.mod": "module example.com/tools\n",
      "tools/gen/gen.go": "package gen\n",
      "scripts/a.go": "package main\n",
      "scripts/b.go": "package other\n",
    });
    expect(
      detectEntryPoints(ctx).map((e) => [e.file, e.reason, e.source]),
    ).toEqual([
      ["scripts/a.go", "convention", "package main"],
      [
        "tools/gen/gen.go",
        "manifest",
        "tools/go.mod (importable package example.com/tools/gen)",
      ],
    ]);
  });

  it("reads the package clause past comments, build tags and a BOM", () => {
    expect(packageClause("package main\n")).toBe("main");
    expect(
      packageClause(
        "﻿//go:build linux\n\n/* doc\n */\n// x\npackage   foo // c\n",
      ),
    ).toBe("foo");
    expect(packageClause("/* unterminated")).toBeUndefined();
    expect(packageClause("func main() {}\n")).toBeUndefined();
    expect(packageClause("")).toBeUndefined();
  });
});
