import { describe, expect, it } from "vitest";
import type {
  FileReader,
  RawImport,
  RepoView,
  ResolveContext,
} from "@epoch-dev/core";
import { resolveImport } from "./resolve.js";
import { detectProjectRoots } from "./roots.js";

/** An in-memory, read-only project (the adapter must stay pure and engine-free). */
function memoryRepo(
  root: string,
  files: Record<string, string | object>,
): RepoView {
  const text = new Map(
    Object.entries(files).map(([rel, v]) => [
      `${root}/${rel}`,
      typeof v === "string" ? v : JSON.stringify(v),
    ]),
  );
  const dirs = new Set<string>([root]);
  for (const abs of text.keys()) {
    for (
      let d = abs.slice(0, abs.lastIndexOf("/"));
      d.length > root.length;
      d = d.slice(0, d.lastIndexOf("/"))
    ) {
      dirs.add(d);
    }
  }
  const reader: FileReader = {
    readFile: (p) => text.get(p),
    fileExists: (p) => text.has(p),
    directoryExists: (p) => dirs.has(p.replace(/\/$/, "")),
    getDirectories: (p) =>
      [...dirs]
        .filter(
          (d) => d.startsWith(`${p}/`) && !d.slice(p.length + 1).includes("/"),
        )
        .map((d) => d.slice(p.length + 1)),
    realpath: (p) => p,
  };
  return { root, files: Object.keys(files).sort(), reader };
}

const ctxFor = (repo: RepoView): ResolveContext => ({
  repo,
  projectRoots: detectProjectRoots(repo),
});

const imp = (
  specifier: string | null,
  extra: Partial<RawImport> = {},
): RawImport => ({
  kind: "static",
  specifier,
  typeOnly: false,
  names: [],
  line: 1,
  ...extra,
});

describe("resolveImport (TS/JS)", () => {
  const repo = memoryRepo("/repo", {
    "package.json": { name: "root", workspaces: ["packages/*"] },
    "tsconfig.json": {
      compilerOptions: {
        module: "nodenext",
        moduleResolution: "nodenext",
        baseUrl: ".",
        paths: { "@app/*": ["src/*"] },
        // a tsconfig plugin is listed but must never be loaded
        plugins: [{ name: "evil-plugin" }],
      },
      include: ["src"],
    },
    "src/a.ts": "",
    "src/b.ts": "export const b = 1;",
    "src/dir/index.ts": "",
    "src/esm.ts": "",
    "src/legacy.js": "",
    "src/data.json": "{}",
    "src/styles.css": "",
    "packages/lib/package.json": {
      name: "@acme/lib",
      exports: {
        ".": {
          types: "./dist/index.d.ts",
          import: "./dist/index.js",
          require: "./dist/index.js",
        },
      },
    },
    "packages/lib/tsconfig.json": {
      compilerOptions: { module: "nodenext", outDir: "dist", rootDir: "src" },
      include: ["src"],
    },
    "packages/lib/src/index.ts": "export const x = 1;",
    "packages/src-lib/package.json": {
      name: "@acme/src-lib",
      exports: { ".": "./src/index.ts" },
    },
    "packages/src-lib/src/index.ts": "",
    "nested/tsconfig.json": {
      compilerOptions: { paths: { "~/*": ["./*"] } },
      include: ["**/*"],
    },
    "nested/x.ts": "",
    "nested/y.ts": "",
  });
  const ctx = ctxFor(repo);
  const from = "src/a.ts";
  const r = (spec: string | null, extra?: Partial<RawImport>, f = from) =>
    resolveImport(imp(spec, extra), f, ctx);

  it("resolves relative imports, directory index and .js -> .ts mapping", () => {
    expect(r("./b")).toEqual({ kind: "file", target: "src/b.ts" });
    expect(r("./dir")).toEqual({ kind: "file", target: "src/dir/index.ts" });
    expect(r("./esm.js")).toEqual({ kind: "file", target: "src/esm.ts" });
  });

  it("honours tsconfig paths and baseUrl", () => {
    expect(r("@app/b")).toEqual({ kind: "file", target: "src/b.ts" });
    expect(r("src/b")).toEqual({ kind: "file", target: "src/b.ts" });
    expect(r("@app/missing")).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
  });

  it("resolves workspace packages to source without node_modules", () => {
    expect(r("@acme/src-lib")).toEqual({
      kind: "file",
      target: "packages/src-lib/src/index.ts",
    });
    // exports points at an unbuilt dist/: mapped back through outDir -> rootDir
    expect(r("@acme/lib")).toEqual({
      kind: "file",
      target: "packages/lib/src/index.ts",
    });
    expect(r("@acme/lib", { kind: "require" })).toEqual({
      kind: "file",
      target: "packages/lib/src/index.ts",
    });
    expect(r("@acme/lib/nope")).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
  });

  it("classifies third-party and builtin modules as externals by package name", () => {
    expect(r("react")).toEqual({ kind: "external", name: "react" });
    expect(r("react/jsx-runtime")).toEqual({ kind: "external", name: "react" });
    expect(r("@scope/pkg/sub/path")).toEqual({
      kind: "external",
      name: "@scope/pkg",
    });
    expect(r("node:fs")).toEqual({ kind: "external", name: "node:fs" });
    expect(r("fs/promises")).toEqual({
      kind: "external",
      name: "node:fs/promises",
    });
  });

  it("gives every unresolved import a reason", () => {
    expect(r("./missing")).toEqual({ kind: "unresolved", reason: "not-found" });
    expect(r("../../outside")).toEqual({
      kind: "unresolved",
      reason: "outside-project",
    });
    expect(r(null, { kind: "dynamic", dynamicPrefix: "./pages/" })).toEqual({
      kind: "unresolved",
      reason: "dynamic-specifier",
      pathPrefix: "src/pages/",
    });
    expect(r(null, { kind: "dynamic" })).toEqual({
      kind: "unresolved",
      reason: "dynamic-specifier",
    });
    expect(r(null, { kind: "dynamic", dynamicPrefix: "pkg/" })).toEqual({
      kind: "unresolved",
      reason: "dynamic-specifier",
    });
  });

  it("links imports of existing non-source files and plain JS", () => {
    expect(r("./data.json")).toEqual({ kind: "file", target: "src/data.json" });
    expect(r("./styles.css")).toEqual({
      kind: "file",
      target: "src/styles.css",
    });
    expect(r("./legacy.js")).toEqual({ kind: "file", target: "src/legacy.js" });
  });

  it("uses the nearest tsconfig that includes the importing file", () => {
    expect(r("~/y", {}, "nested/x.ts")).toEqual({
      kind: "file",
      target: "nested/y.ts",
    });
    expect(r("~/y")).toEqual({ kind: "external", name: "~" });
  });
});

describe("resolveImport without any tsconfig", () => {
  const repo = memoryRepo("/plain", {
    "package.json": { name: "plain", main: "index.js" },
    "index.js": "",
    "lib/index.js": "",
    "util.mjs": "",
  });
  const ctx = ctxFor(repo);

  it("uses bundler-style defaults for plain JS", () => {
    expect(resolveImport(imp("./lib"), "index.js", ctx)).toEqual({
      kind: "file",
      target: "lib/index.js",
    });
    expect(resolveImport(imp("./util.mjs"), "index.js", ctx)).toEqual({
      kind: "file",
      target: "util.mjs",
    });
    expect(resolveImport(imp("lodash"), "index.js", ctx)).toEqual({
      kind: "external",
      name: "lodash",
    });
  });
});

describe("detectProjectRoots", () => {
  it("finds tsconfigs, packages and pnpm workspace packages", () => {
    const repo = memoryRepo("/ws", {
      "package.json": { name: "ws-root" },
      "pnpm-workspace.yaml":
        "packages:\n  - packages/*\n  - '!packages/ignored'\n",
      "packages/a/package.json": { name: "@ws/a" },
      "packages/ignored/package.json": { name: "@ws/ignored" },
      "tools/package.json": { name: "tools" },
      "packages/a/tsconfig.json": "{}",
    });
    const roots = detectProjectRoots(repo).map(
      (r) => `${r.kind}:${r.dir}:${r.name ?? ""}`,
    );
    expect(roots).toEqual([
      "workspace-root::",
      "package::ws-root",
      "package:packages/a:@ws/a",
      "workspace-package:packages/a:@ws/a",
      "tsconfig:packages/a:",
      "package:packages/ignored:@ws/ignored",
      "package:tools:tools",
    ]);
  });
});

describe("resolveImport with a Windows drive-letter root", () => {
  // Engine roots are forward-slash absolute paths, so on Windows they start
  // with a drive letter; path.posix must never treat them as relative.
  const repo = memoryRepo("C:/repo", {
    "src/a.ts": "",
    "src/b.ts": "",
    "src/styles.css": "",
  });
  const ctx = ctxFor(repo);
  const r = (spec: string | null, extra?: Partial<RawImport>) =>
    resolveImport(imp(spec, extra), "src/a.ts", ctx);

  it("resolves sources, existing assets and dynamic prefixes", () => {
    expect(r("./b")).toEqual({ kind: "file", target: "src/b.ts" });
    expect(r("./styles.css")).toEqual({
      kind: "file",
      target: "src/styles.css",
    });
    expect(r(null, { kind: "dynamic", dynamicPrefix: "./pages/" })).toEqual({
      kind: "unresolved",
      reason: "dynamic-specifier",
      pathPrefix: "src/pages/",
    });
    expect(r("./missing.css")).toEqual({
      kind: "unresolved",
      reason: "not-found",
    });
    expect(r("../../outside")).toEqual({
      kind: "unresolved",
      reason: "outside-project",
    });
  });
});
