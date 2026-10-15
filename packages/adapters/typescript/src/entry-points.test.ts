import { describe, expect, it } from "vitest";
import type { ProjectContext, RepoView } from "@epoch-dev/core";
import { detectEntryPoints } from "./entry-points.js";
import { detectProjectRoots } from "./roots.js";

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

const roots = (files: Readonly<Record<string, string>>) =>
  detectEntryPoints(project(files)).map((e) => [e.file, e.reason, e.source]);

describe("typescript entry points", () => {
  it("maps manifest targets from build output back to source through tsconfig", () => {
    expect(
      roots({
        "package.json": JSON.stringify({
          main: "./dist/index.js",
          types: "./dist/index.d.ts",
          bin: { tool: "./dist/cli/run.js" },
          exports: {
            ".": { import: "./dist/index.js" },
            "./extra": { default: "./dist/extra.mjs" },
          },
        }),
        "tsconfig.json":
          '{ // comment\n "compilerOptions": { "outDir": "dist", "rootDir": "lib" } }',
        "lib/index.ts": "",
        "lib/cli/run.ts": "",
        "lib/extra.mts": "",
      }),
    ).toEqual([
      ["lib/index.ts", "manifest", "package.json main"],
      ["lib/index.ts", "manifest", "package.json types"],
      ["lib/cli/run.ts", "manifest", "package.json bin"],
      ["lib/index.ts", "manifest", "package.json exports"],
      ["lib/extra.mts", "manifest", "package.json exports"],
    ]);
  });

  it("falls back to src/ when tsconfig names no rootDir, and keeps source targets as they are", () => {
    expect(
      roots({
        "pkg/package.json": JSON.stringify({
          main: "dist/index.js",
          module: "esm/index.js",
        }),
        "pkg/tsconfig.json": JSON.stringify({
          compilerOptions: { outDir: "dist" },
        }),
        "pkg/src/index.ts": "",
        "pkg/esm/index.js": "",
      }),
    ).toEqual([
      ["pkg/src/index.ts", "manifest", "pkg/package.json main"],
      ["pkg/esm/index.js", "manifest", "pkg/package.json module"],
    ]);
  });

  it("finds files named in package scripts", () => {
    expect(
      roots({
        "package.json": JSON.stringify({
          scripts: {
            gen: "node scripts/gen.mjs --out x && tsx ./tools/run.ts",
            missing: "node scripts/nope.js",
          },
        }),
        "scripts/gen.mjs": "",
        "tools/run.ts": "",
      }),
    ).toEqual([
      ["scripts/gen.mjs", "script", "package.json scripts.gen"],
      ["tools/run.ts", "script", "package.json scripts.gen"],
    ]);
  });

  it("finds tool config files, conventional names, bin/ files and index.html scripts", () => {
    expect(
      roots({
        "vite.config.ts": "",
        "packages/a/vitest.config.mts": "",
        ".eslintrc.cjs": "",
        "src/main.tsx": "",
        "cli.js": "",
        "bin/run.js": "",
        "src/util.ts": "",
        "index.html":
          '<html><script type="module" src="/src/app.ts"></script><SCRIPT SRC="https://cdn.example/x.js"></SCRIPT></html>',
        "src/app.ts": "",
      }),
    ).toEqual([
      [".eslintrc.cjs", "config", ".eslintrc.cjs (tool configuration)"],
      ["bin/run.js", "convention", "bin/ directory"],
      ["cli.js", "convention", "cli.js (entry-point name)"],
      [
        "packages/a/vitest.config.mts",
        "config",
        "vitest.config.mts (tool configuration)",
      ],
      ["src/main.tsx", "convention", "main.tsx (entry-point name)"],
      ["vite.config.ts", "config", "vite.config.ts (tool configuration)"],
      ["src/app.ts", "convention", "index.html <script>"],
    ]);
  });

  it("ignores a manifest that does not parse", () => {
    expect(roots({ "package.json": "{ nope", "src/index.ts": "" })).toEqual([]);
  });
});
