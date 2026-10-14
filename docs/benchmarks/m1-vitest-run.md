# M1 real-repo run: vitest

The PLAN.md M1 acceptance asks for `epoch analyze` to run on one real mid-size TS repo without crashing, and for the counts to be reported. These are counts only. **No accuracy is claimed**; edge precision and recall against ground truth come in M2.

## Setup

- **Repo:** `vitest-dev/vitest` at `2899eb3e97931aaaba561013f483cb671506eea4` (MIT). It was shallow-cloned and never installed, built or run, so there is no `node_modules` and no `dist/`.
- **Command:** `node packages/cli/dist/bin.js analyze <clone> --json`, run 5 times.
- **Hardware:** Linux x64, Intel Xeon @ 2.10 GHz, 4 vCPU, 15 GiB RAM, Node 24.21.0. Parsing is single-threaded in M1.

## Results

- Exit code 0 on every run.
- The stdout graph validates against the `Graph` schema and was byte-identical across all 5 runs (2.9 MB of JSON).
- `git status` in the clone was clean afterwards.

| Measure                                           | Value                                                                                              |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Files analyzed                                    | 2,400 (2,136 TypeScript, 264 JavaScript)                                                           |
| Nodes                                             | 2,451. The other 51 are imported non-source files: 20 Vue, 16 JSON, 8 CSS and 7 others             |
| Edges                                             | 7,179: 4,296 `import`, 1,360 `via-barrel`, 1,211 `type-only`, 204 `reexport`, 108 `dynamic-import` |
| Externals                                         | 210 distinct packages                                                                              |
| Unresolved                                        | 361: 313 `not-found`, 45 `dynamic-specifier`, 3 `outside-project`                                  |
| Cycles (certain edges)                            | 20                                                                                                 |
| Skipped files                                     | 0                                                                                                  |
| Files with syntax errors                          | 9                                                                                                  |
| Analysis time (`AnalysisMeta`)                    | median 3.75 s (min 3.42, max 3.95)                                                                 |
| Wall time, including Node startup and JSON output | median 4.32 s                                                                                      |
| Peak RSS                                          | median 305 MiB                                                                                     |

## What the unresolved imports are

**267 imports of workspace packages.** These are `vitest` (235), `@vitest/browser` (16), `@vitest/browser-playwright` (9), `@vitest/browser-preview` (5), and one each of the two coverage packages.

- Their `package.json` `exports` point at a `dist/` that is built by a bundler, not by `tsc`. The `outDir` → `rootDir` mapping therefore cannot find the source.
- vitest maps them to source with a custom export condition (`__vitest_source__`). That condition is declared only in `tsconfig.base.json`, and most importing tsconfigs (e.g. `test/browser`) do not extend that file.

**46 relative imports.**

| Count | Cause                                                                                                                                                |
| ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
|    21 | Point into an unbuilt `dist/`                                                                                                                        |
|    15 | Use Vite query suffixes (`?raw`, `?inline`, `?worker`)                                                                                               |
|    10 | Directories with no index or source entry, paths deliberately missing in tests, or extensionless `.mjs` imports that TypeScript's resolution rejects |

**45 dynamic imports** whose specifier is not a literal. None has a literal path prefix.

**3 root-absolute specifiers** (`/@vite/client`, `/data`), reported as `outside-project`.

## Files with syntax errors

The parser recovered from errors in these 9 files. Their facts are best-effort, and barrel tracing through them stays conservative.

- **6 hit two gaps in the TypeScript grammar.** The latest official release has the same gaps (ADR-002):
  - `export type * from` (TS 5.0): 4 files;
  - a generic call signature on the line after another interface member: 2 files.
- **3 are vitest's deliberately broken test fixtures.**
