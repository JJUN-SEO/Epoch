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

  it("maps a bundler's dist/ back to src/ when tsconfig names no outDir", () => {
    expect(
      roots({
        "packages/p/package.json": JSON.stringify({
          exports: {
            ".": { import: "./dist/index.mjs", require: "./dist/index.cjs" },
            "./tool": "./lib/tool.js",
          },
        }),
        "packages/p/src/index.ts": "",
        "packages/p/src/tool.ts": "",
      }),
    ).toEqual([
      [
        "packages/p/src/index.ts",
        "manifest",
        "packages/p/package.json exports",
      ],
      [
        "packages/p/src/index.ts",
        "manifest",
        "packages/p/package.json exports",
      ],
      ["packages/p/src/tool.ts", "manifest", "packages/p/package.json exports"],
    ]);
  });

  it("maps a bundler's .cjs and .d.cts back to the .cts source when there is one", () => {
    expect(
      roots({
        "pkg/package.json": JSON.stringify({
          exports: {
            ".": {
              types: "./dist/index.d.cts",
              import: "./dist/index.js",
              require: "./dist/index.cjs",
            },
          },
        }),
        "pkg/src/index.ts": "",
        "pkg/src/index.cts": "",
      }),
    ).toEqual([
      ["pkg/src/index.cts", "manifest", "pkg/package.json exports"],
      ["pkg/src/index.ts", "manifest", "pkg/package.json exports"],
      ["pkg/src/index.cts", "manifest", "pkg/package.json exports"],
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

  it("maps a script's build output back to source through the package that owns it", () => {
    expect(
      roots({
        "package.json": JSON.stringify({
          scripts: {
            bench: "pnpm build && node packages/bench/dist/perf.js",
            other: "node packages/bench/dist/missing.js",
          },
        }),
        "packages/bench/package.json": JSON.stringify({ name: "bench" }),
        "packages/bench/src/perf.ts": "",
      }),
    ).toEqual([
      ["packages/bench/src/perf.ts", "script", "package.json scripts.bench"],
    ]);
  });

  it("takes a folder a runner is given as its index file, and only for runners", () => {
    expect(
      roots({
        "package.json": JSON.stringify({
          scripts: {
            dev: "NODE_ENV=development tsx watch src",
            lint: "eslint lib",
          },
        }),
        "src/index.ts": "",
        "lib/index.ts": "",
      }),
    ).toEqual([["src/index.ts", "script", "package.json scripts.dev"]]);
  });

  it("counts the files a nested tsconfig type-checked by a script includes", () => {
    expect(
      roots({
        "package.json": JSON.stringify({
          scripts: {
            "test:types":
              "tsc --project fixtures/ai/tsconfig.json && tsc -p fixtures/cjs",
            build: "tsc -p tsconfig.json",
          },
        }),
        "tsconfig.json": JSON.stringify({ include: ["src"] }),
        "src/unused.ts": "",
        "fixtures/ai/tsconfig.json": JSON.stringify({
          compilerOptions: { noEmit: true },
          include: ["./**/*.ts"],
        }),
        "fixtures/ai/index.ts": "",
        "fixtures/ai/helper.ts": "",
        "fixtures/cjs/tsconfig.json": JSON.stringify({ files: ["a.cts"] }),
        "fixtures/cjs/a.cts": "",
        "fixtures/cjs/b.cts": "",
      }),
    ).toEqual([
      [
        "fixtures/ai/helper.ts",
        "script",
        "package.json scripts.test:types (tsc --project fixtures/ai/tsconfig.json)",
      ],
      [
        "fixtures/ai/index.ts",
        "script",
        "package.json scripts.test:types (tsc --project fixtures/ai/tsconfig.json)",
      ],
      [
        "fixtures/cjs/a.cts",
        "script",
        "package.json scripts.test:types (tsc --project fixtures/cjs/tsconfig.json)",
      ],
    ]);
  });

  it("finds files GitHub workflows run or import", () => {
    expect(
      roots({
        ".github/workflows/ci.yml": [
          "jobs:",
          "  check:",
          "    steps:",
          "      - run: node ./scripts/check.mjs --strict",
          "      - uses: actions/github-script@v7",
          "        with:",
          "          script: |",
          "            const { default: run } = await import(`${process.env.GITHUB_WORKSPACE}/.github/scripts/pr.js`)",
        ].join("\n"),
        ".github/workflows/docs.yaml": "      - run: pnpm tsx docs/build.ts",
        "scripts/check.mjs": "",
        ".github/scripts/pr.js": "",
        ".github/scripts/unused.js": "",
        "docs/build.ts": "",
        "docs/.github/workflows/not-read.yml":
          "      - run: node docs/other.ts",
        "docs/other.ts": "",
      }).filter(([, reason]) => reason === "script"),
    ).toEqual([
      ["scripts/check.mjs", "script", ".github/workflows/ci.yml"],
      [".github/scripts/pr.js", "script", ".github/workflows/ci.yml"],
      ["docs/build.ts", "script", ".github/workflows/docs.yaml"],
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

  it("finds files a tool config names by path", () => {
    expect(
      roots({
        "packages/v/rollup.config.js":
          "export default { input: { index: 'src/index.ts', 'workers/forks': './src/workers/forks' }, external: ['node:fs', 'src/**'] };",
        // An apostrophe in a comment must not throw off the quote pairing.
        "packages/v/vitest.config.ts":
          "// we don't bundle 'these'\n/* nor 'src/unrelated' */\nexport default { test: { setupFiles: [\"./test-setup\"] } };",
        "packages/v/src/index.ts": "",
        "packages/v/src/workers/forks.ts": "",
        "packages/v/test-setup.ts": "",
        "packages/v/src/unrelated.ts": "",
      }).filter(([, , source]) => source?.includes("names this path") === true),
    ).toEqual([
      [
        "packages/v/src/index.ts",
        "config",
        "packages/v/rollup.config.js (names this path)",
      ],
      [
        "packages/v/src/workers/forks.ts",
        "config",
        "packages/v/rollup.config.js (names this path)",
      ],
      [
        "packages/v/test-setup.ts",
        "config",
        "packages/v/vitest.config.ts (names this path)",
      ],
    ]);
  });

  it("finds files Nx, Angular and NestJS configs name, relative to the file or the workspace", () => {
    expect(
      roots({
        "packages/app/project.json": JSON.stringify({
          targets: {
            build: {
              options: { main: "packages/app/src/main.ts" },
              configurations: {
                production: {
                  fileReplacements: [
                    {
                      replace: "packages/app/src/environments/environment.ts",
                      with: "packages/app/src/environments/environment.prod.ts",
                    },
                  ],
                },
              },
            },
          },
        }),
        "packages/app/src/main.ts": "",
        "packages/app/src/environments/environment.ts": "",
        "packages/app/src/environments/environment.prod.ts": "",
        "svc/nest-cli.json": JSON.stringify({
          sourceRoot: "src",
          entryFile: "main",
        }),
        "svc/src/main.ts": "",
      }).filter(([, , source]) => source?.includes("names this path") === true),
    ).toEqual([
      [
        "packages/app/src/main.ts",
        "config",
        "packages/app/project.json (names this path)",
      ],
      [
        "packages/app/src/environments/environment.ts",
        "config",
        "packages/app/project.json (names this path)",
      ],
      [
        "packages/app/src/environments/environment.prod.ts",
        "config",
        "packages/app/project.json (names this path)",
      ],
    ]);
  });

  it("counts what Vue, Svelte, Astro and MDX files import, resolved as TS would", () => {
    expect(
      roots({
        "tsconfig.json": JSON.stringify({
          compilerOptions: { baseUrl: ".", paths: { "~/*": ["src/*"] } },
        }),
        "src/App.vue":
          '<script setup lang="ts">\nimport { useX } from "~/composables/x";\nimport Y from "./y.vue";\nconst lazy = () => import("./lazy");\n</script>',
        "src/Page.svelte": '<script>\n  import "./side";\n</script>',
        "src/composables/x.ts": "",
        "src/lazy.ts": "",
        "src/side.ts": "",
        "src/unused.ts": "",
      }),
    ).toEqual([
      [
        "src/composables/x.ts",
        "convention",
        "src/App.vue imports it (.vue files are not analyzed)",
      ],
      [
        "src/lazy.ts",
        "convention",
        "src/App.vue imports it (.vue files are not analyzed)",
      ],
      [
        "src/side.ts",
        "convention",
        "src/Page.svelte imports it (.svelte files are not analyzed)",
      ],
    ]);
  });

  it("reads script tags of every HTML page", () => {
    expect(
      roots({
        "src/client/tester.html":
          '<script type="module" src="./tester.ts"></script>',
        "src/client/tester.ts": "",
      }),
    ).toEqual([
      ["src/client/tester.ts", "convention", "src/client/tester.html <script>"],
    ]);
  });

  it("finds executable scripts", () => {
    expect(
      roots({
        "scripts/release.mjs": "#!/usr/bin/env node\n",
        "src/lib.ts": "export {};\n",
      }),
    ).toEqual([
      ["scripts/release.mjs", "convention", "executable script (#!)"],
    ]);
  });

  it("ignores a manifest that does not parse", () => {
    expect(roots({ "package.json": "{ nope", "src/index.ts": "" })).toEqual([]);
  });
});
