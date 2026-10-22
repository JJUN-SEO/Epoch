import { describe, expect, it } from "vitest";
import {
  exportTargets,
  nearestTsconfig,
  pnpmWorkspaceGlobs,
  workspaceGlobs,
} from "./reference.js";

describe("workspace globs", () => {
  it("reads the packages list of pnpm-workspace.yaml", () => {
    const yaml = [
      "# comment",
      "packages:",
      "  - packages/*",
      "  - 'docs'",
      '  - "!**/test/**"',
      "catalog:",
      "  typescript: ^5.9.0",
    ].join("\n");
    expect(pnpmWorkspaceGlobs(yaml)).toEqual([
      "packages/*",
      "docs",
      "!**/test/**",
    ]);
    expect(pnpmWorkspaceGlobs("catalog:\n  a: 1\n")).toEqual([]);
  });

  it("reads package.json workspaces, as a list or under packages", () => {
    expect(workspaceGlobs({ workspaces: ["packages/*"] })).toEqual([
      "packages/*",
    ]);
    expect(workspaceGlobs({ workspaces: { packages: ["apps/*"] } })).toEqual([
      "apps/*",
    ]);
    expect(workspaceGlobs({ name: "x" })).toEqual([]);
  });
});

describe("exportTargets", () => {
  const exports = {
    "./package.json": "./package.json",
    ".": {
      "@zod/source": "./src/index.ts",
      types: "./index.d.cts",
      import: "./index.js",
    },
    "./v4": {
      "@zod/source": "./src/v4/index.ts",
      import: { types: "./v4/index.d.ts", default: "./v4/index.js" },
    },
    "./locales/*": { "@zod/source": "./src/locales/*.ts" },
  };

  it("lists every target of a subpath, through nested conditions", () => {
    expect(exportTargets(exports, ".")).toEqual([
      "src/index.ts",
      "index.d.cts",
      "index.js",
    ]);
    expect(exportTargets(exports, "./v4")).toEqual([
      "src/v4/index.ts",
      "v4/index.d.ts",
      "v4/index.js",
    ]);
  });

  it("fills a subpath pattern", () => {
    expect(exportTargets(exports, "./locales/en")).toEqual([
      "src/locales/en.ts",
    ]);
  });

  it("treats a string or an array of exports as the root subpath", () => {
    expect(exportTargets("./main.js", ".")).toEqual(["main.js"]);
    expect(exportTargets(["./a.js", { import: "./b.js" }], ".")).toEqual([
      "a.js",
      "b.js",
    ]);
    expect(exportTargets("./main.js", "./x")).toEqual([]);
  });
});

describe("nearestTsconfig", () => {
  const includes: Record<string, readonly string[]> = {
    "tsconfig.json": [],
    "packages/a/tsconfig.json": ["packages/a/src/x.ts"],
    "packages/b/tsconfig.json": ["packages/b/other.ts"],
  };
  const includedBy = (config: string, file: string) =>
    (includes[config] ?? []).includes(file);
  const exists = (config: string) => config in includes;

  it("picks the closest tsconfig.json that includes the file", () => {
    expect(nearestTsconfig("packages/a/src/x.ts", exists, includedBy)).toBe(
      "packages/a/tsconfig.json",
    );
  });

  it("keeps walking up past one that does not include it, and gives up at the root", () => {
    expect(nearestTsconfig("packages/b/src/y.ts", exists, includedBy)).toBe(
      undefined,
    );
  });
});
