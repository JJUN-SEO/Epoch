# ADR-002: tree-sitter runtime and grammar sourcing

- **Status:** Accepted
- **Date:** 2026-10-14
- **Milestone:** M1

## Context

CLAUDE.md mandates `web-tree-sitter` with WASM grammars for the Parse stage. PLAN.md M1 asks to pin the runtime and the grammar WASMs together, and warns that a grammar WASM's ABI must be one the runtime supports, so a startup self-test is required.

The grammars must load in Node 24 today and later in Electron's analysis host. Installing them must not run native build scripts, because pnpm's `strictDepBuilds` is on and native builds are fragile across macOS, Windows and Linux. The same source should also cover the M3 (Python) and M4 (Go) grammars.

## Options and evidence

Measured in a scratch workspace on 2026-10-14 (Node 24.21.0, Linux x64). Each WASM was loaded with `Language.load` and parsed a snippet.

| Source                                                                                    | Result                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree-sitter-typescript` 0.23.2 + `tree-sitter-javascript` 0.25.0 (official npm packages) | WASMs load (ABI 14/14/15), but both packages run `node-gyp-build` as an install script, which tries to build a native addon, and depend on `node-addon-api`. The TypeScript package alone is 43 MB.                          |
| `tree-sitter-wasms` 0.1.13                                                                | Every grammar **fails to load** in web-tree-sitter 0.27.1 (incompatible ABI).                                                                                                                                                |
| `@vscode/tree-sitter-wasm` 0.3.1 (MIT, published by Microsoft for VS Code)                | TypeScript, TSX and JavaScript load and parse (ABI 14/14/15), and so do Python and Go (ABI 15) for M3/M4, plus most Tier B languages (bash, C#, C++, Java, PHP, Ruby, Rust). **No install scripts, no dependencies**, 22 MB. |
| Building grammar WASMs ourselves                                                          | Needs emscripten or docker in every environment. Rejected.                                                                                                                                                                   |

## Decision

- **Runtime:** `web-tree-sitter` 0.27.1, which supports grammar ABI 13–15 (`MIN_COMPATIBLE_VERSION`, `LANGUAGE_VERSION`).
- **Grammars:** `@vscode/tree-sitter-wasm` 0.3.1. Both are exact pins in `packages/engine`, and they are upgraded together, never separately.
- **Extension mapping** (`@epoch-dev/adapter-typescript`'s registration): `.ts .mts .cts .d.ts` use `typescript`, `.tsx` uses `tsx`, and `.js .jsx .mjs .cjs` use `javascript`. The JavaScript grammar parses JSX.
- **Startup self-test** (`packages/engine/src/parse.ts`). Before a grammar is used:
  - Its `abiVersion` must be inside the runtime's supported range. Otherwise loading fails with a message that names both packages.
  - A canary snippet must parse to the expected top-level node types with no error nodes.
  - Any failure stops the analysis rather than producing a wrong graph.

## Measured cost

Linux x64, Intel Xeon 2.10 GHz, 4 vCPU, Node 24.21.0. Script: `parse-bench.mjs` against `packages/engine/dist/parse.js`, 11 runs, median reported.

- Initializing the runtime, then loading and self-testing the three grammars: **25.9 ms**.
- Parsing a 2,000-line TypeScript file: **median 21.4 ms** (min 15.1, max 40.5).

These are single measurements on one machine to show the order of magnitude, not benchmarks. M2's `pnpm bench` measures the pipeline properly.

## Consequences

- No native code and no install scripts in the parsing path, so `allowBuilds` stays empty and installs behave the same on all three OSes.
- The VS Code package's WASMs do not embed the upstream grammar versions (`Language.metadata` is null for the ABI 14 grammars). Provenance is the pinned package version. The self-test and the TS/JS conformance suite catch behaviour drift on an upgrade.
- **Known grammar gaps.** Found on vitest (see `docs/benchmarks/m1-vitest-run.md`); `tree-sitter-typescript` 0.23.2, the latest official release, has the same gaps:
  - `export type * from` (TS 5.0): the `type` keyword ends up in an ERROR node, and the extractor reads the rest of the statement.
  - A generic call signature (`<T>(…)`) on the line after another interface member: error recovery can swallow the rest of the file.
  - Files with syntax errors are reported in `AnalysisMeta.parseErrors`, and barrel tracing through them stays conservative (ADR-003).
- Trees live in WASM memory: the engine deletes each tree after extraction.
- Packaging (M3, M8): the `.wasm` files and the tree-sitter queries in `queries/` must ship unpacked (`asarUnpack` in Electron, copied for the npm CLI). Today they are found through package-relative paths.

## Sources

- web-tree-sitter 0.27.1 typings (`Language.load`, `new Query(language, source)`, `LANGUAGE_VERSION`, `MIN_COMPATIBLE_VERSION`), read from the installed package.
- `npm view tree-sitter-typescript@0.23.2 scripts dependencies`, `npm view tree-sitter-javascript@0.25.0 scripts dependencies`, `npm view @vscode/tree-sitter-wasm@0.3.1 scripts license`.
- https://github.com/tree-sitter/tree-sitter (web binding); https://www.npmjs.com/package/@vscode/tree-sitter-wasm
