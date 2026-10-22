# ADR-003: Barrel tracing over tree-sitter facts, not the TypeScript checker

- **Status:** Accepted
- **Date:** 2026-10-14
- **Milestone:** M1

## Context

The Barrel transparency rule (CLAUDE.md) needs, for each name imported through a barrel, the file that declares it. There are two ways to get that.

| Option                        | How it works                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Our own tracing**        | `buildGraph` in `core` follows `export … from` and `export *` over the cached `FileFacts` that tree-sitter extraction already produces. Purely syntactic. |
| **B. The TypeScript checker** | Build a `ts.Program` over the repo, then for each imported name call `getSymbolAtLocation` → `getAliasedSymbol` and take the declaration's file.          |

PLAN.md says to decide by measuring both on one real repo.

## Method

- **Repo:** `vitest-dev/vitest` at `2899eb3e97931aaaba561013f483cb671506eea4` (MIT). It was shallow-cloned and never installed, built or run, so there is no `node_modules`.
- **Script:** `packages/engine/src/bench/barrel-compare.ts`.
  - Both sides use the same module resolution: our TS adapter's `resolveImport` feeds the Program through `resolveModuleNameLiterals`. Any difference therefore comes from tracing alone.
  - The Program reads through the same root-confined, read-only `FsReader`, with `noLib`, `types: []` and `allowJs`.
- **Unit of comparison:** a triple _(importing file A, barrel B, declaring file C ≠ B)_.
  - Ours: every edge evidence `via barrel B`.
  - Checker: every default or named binding of an ESM import declaration whose declaration lies in exactly one repo file other than B.
  - Namespace, side-effect, dynamic and `require` imports are untraced on both sides.
- **Runs:** each side ran 3 times in its own process, so peak RSS is per approach. The triples were identical across runs; timings are the median of 3.
- **Hardware:** Linux x64, Intel Xeon @ 2.10 GHz, 4 vCPU, 15 GiB RAM, Node 24.21.0.

## Results

**Cost**

|                | A. Ours                                                                                              | B. Checker                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Traced triples | 2,504                                                                                                | 2,669                                                       |
| Time           | Full pipeline: 3.48 s (parse 2.10 s, resolve 1.19 s). Tracing happens inside the graph stage: 0.09 s | Program and checker: 3.25 s. Queries: 0.37 s. Total: 3.71 s |
| Peak RSS       | 279 MiB                                                                                              | 500 MiB                                                     |

The checker's time includes our resolver (shared with A). It does not include the tree-sitter parse, which Epoch needs anyway for the M5 flag and constant-condition facts and for every non-TS language.

**Agreement.** This is agreement with the checker, not accuracy against ground truth.

- 2,483 triples agree (Jaccard 0.923).
- 21 triples are ours-only and 186 are checker-only.
- The checker could not trace 195 bindings to a symbol (mostly names from external packages, since there is no `node_modules`), and found 60 declared in several files.

**Every disagreement, classified by rule.** None was left unexplained.

|   Count | Found by       | Cause                                                                                                                                                                                                                                                      | Effect on our graph                  |
| ------: | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
|      97 | checker        | The barrel has `export *` from an external or unresolved module (e.g. `packages/vitest/browser/context.d.ts` re-exports `@vitest/browser-webdriverio/context`). The checker ignores a star source it cannot see, but that module may export the same name. | Conservative A→B edge                |
| 27 + 12 | checker + ours | An intermediate file re-exports an imported binding (`import { x } from "./c"` then `export { x }`). We stop at that file; the checker follows it to the declaration.                                                                                      | Real dependency, less precise target |
|      20 | checker        | The same shape in the barrel itself                                                                                                                                                                                                                        | Conservative A→B edge                |
|      21 | checker        | The declaring file was only partly parsed because of a grammar gap (ADR-002)                                                                                                                                                                               | Conservative A→B edge                |
|      20 | checker        | Checker artifact: `.vue` imports typed by an ambient `declare module "*.vue"` shim elsewhere in the repo                                                                                                                                                   | Ours is right                        |
|       9 | ours           | Declaration merging: the checker sees the name declared in several files; we name the file that exports it                                                                                                                                                 | Real dependency                      |
|       1 | checker        | `export *` cycle (`test/unit/src/self/index.ts` re-exports itself)                                                                                                                                                                                         | Conservative A→B edge                |

## Decision

Keep **option A**: syntactic tracing in `core` over `FileFacts`.

1. **No false dependencies in this sample.** In every disagreement, our graph is either conservative (it keeps the direct edge to the barrel) or names a file the importer really depends on. None is an edge to a file the importer does not depend on.
2. **Cost.** Tracing is a small part of a 0.09 s graph stage that works on facts we extract anyway. The checker adds a second full parse and bind of every file: 3.71 s and 500 MiB peak on its own for this repo.
3. **One mechanism for every language.** The same `core` tracing will serve Python `__init__.py` re-exports (M3). The checker is TS-only.
4. **Fits the cache.** `FileFacts` is the cached unit (M2), and tracing is a pure function over it. The checker needs a whole Program per run.

Both options are read-only and never execute project code, so safety does not decide between them.

## Consequences

- Where our tracing is conservative, blast radius over-approximates: A appears affected by changes to the barrel's other re-exports. This is the trade-off the Barrel transparency rule already accepts.
- Not built yet (follow-ups):
  - Treat `import { x } from "./c"; export { x }` (and `export default x` of an imported binding) as a re-export in the TS extractor. That would close 59 of the 207 disagreements. It starts with a fixture, per the graph-correctness rule, and is measured with M2's accuracy benchmark.
- The script stays in the repo so that M2 can rerun it on more repos.

## Sources

- TypeScript 6.0.3 compiler API (`createProgram`, `CompilerHost.resolveModuleNameLiterals`, `TypeChecker.getSymbolAtLocation`, `getAliasedSymbol`), read from the installed `typescript` package typings.
- Raw outputs: `barrel-compare ours|checker|compare`, run from the scratch directory against the clone above. They are not committed, because they contain only data derived from the vitest repo, and are reproducible from the pinned commit.
