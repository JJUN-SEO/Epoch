# ADR-006: Precision upgrades (SCIP and language-native tooling)

- **Status:** Accepted
- **Date:** 2026-10-15
- **Milestone:** M3 (written before the Python adapter)

## Context

CLAUDE.md asks for an ADR on precision upgrades before building a custom resolver for each Tier A language: SCIP indexers from Sourcegraph, or each language's own tooling. Any option that runs project-controlled code violates principle 8 ("parse, never execute") unless it is sandboxed, and this ADR must address that.

The question is whether Epoch should hand resolution to such tools for TS/JS, Python and the later Tier A languages, instead of its own adapters.

## Options and evidence

Read from each tool's current documentation on 2026-10-15.

**scip-typescript** (Sourcegraph)

- **What it needs:** the README's usage steps are `npm install` (or `yarn install` / `pnpm install`), then `scip-typescript index`, run from the project root. It also has `--infer-tsconfig` and workspace flags.
- **Principle 8:** installing a project's dependencies runs their install scripts, which is project-controlled code. Indexing without an install loses the type information that makes SCIP more precise than plain module resolution.

**scip-python** (Sourcegraph)

- **What it needs:** "scip-python uses `pip` to attempt to determine the versions and names of the packages available in your environment" and says to "activate your virtual environment before running". An `--environment` JSON file can replace the pip calls.
- **Principle 8:** it runs the project's environment (pip, Python). A project virtualenv can execute code at interpreter start-up through `.pth` files and `sitecustomize`.

**Pyright import resolution** (the base of scip-python)

- **What it needs:** "If no site-packages directory can be found, Pyright attempts to run the configured Python interpreter and ask it for its search paths. If no Python environment is configured, Pyright will use the default Python interpreter by invoking `python`." Its docs also note that resolving editable installs that use import hooks "requires executing Python code".
- **Principle 8:** it can run an interpreter, and with it the project-controlled start-up code above.

**Language-native probes** (`importlib.util.find_spec`, `go list`, `tsc --traceResolution`)

- **What it needs:** running the language toolchain on the project. `find_spec("a.b")` imports the parent package `a`.
- **Principle 8:** executes package code or toolchain plugins. `go list` is a separate case: it reads `go.mod` and needs no project code, so it is judged on its own in the Go ADR work (M4).

**Epoch's own resolvers** (current design)

- **What it needs:** files read as data. tree-sitter extracts imports; each adapter resolves them with the language's documented rules: TypeScript's own `resolveModuleName` over a read-only host, and Python's import system rules (M3).
- **Principle 8:** satisfied by design and covered by the safety tests (evil `extends`, install scripts).

**Measured precision of the current approach** (`docs/benchmarks/typescript.md`): every disagreement with dependency-cruiser on zod and vitest was classified, with zero unclassified. The Epoch-wrong cases that turned up (bundler query suffixes, triple-slash references, extensionless `.mjs`) were fixed in M2.

## Decision

1. **Epoch keeps its own resolvers for every language**, built from the language's documented rules and run over files read as data. No indexer or toolchain runs on a user's project.
2. SCIP indexers and language-native tools are allowed only as **offline benchmark aids**, run by developers on pinned clones in a scratch directory, never by Epoch on a user's project. Example: comparing Python edges with grimp or a pyright-based tool in the M4 accuracy work.
3. **Revisit in v2** only with a real sandbox (no network, no write access outside a temp directory, a restricted interpreter or toolchain) and a measured precision gain that the classified disagreements say is worth it.

## Consequences

- Python resolution is specified from the import system rules: `sys.path`-style roots, regular and namespace packages, relative imports, and the stdlib list bundled from CPython's generated `stdlib_module_names.h`. It never asks an interpreter.
- What static resolution cannot see (runtime `sys.path` edits, import hooks, `importlib` with computed names, plugin systems) stays `unresolved` with a reason, and the UI says so (CLAUDE.md: honest about coverage).
- Tier A claims still need a measured accuracy number per language (CLAUDE.md). For Python that measurement is scheduled for M4.

## Amendment (2026-10-22): benchmark references set up like the repository

**Why.** Raw precision had been measured against a handicapped reference. Every TS/JS disagreement on zod and vitest was an edge Epoch found and dependency-cruiser could not:

- it ran without `node_modules`, so the repo's own workspace packages were invisible;
- it read only the root tsconfig.

So raw precision said more about the reference than about Epoch. Both repos map their package names to source through a custom export condition (`@zod/source`, `__vitest_source__`), switched on by `customConditions` in their tsconfigs. A reference given the environment the repo declares can therefore check Epoch's targets on its own.

**What changed in `pnpm bench:accuracy`.** The rule: only what the repository declares, applied to every file the same way, and read by the benchmark itself rather than taken from Epoch's resolver.

- **Scratch copy.** The tool runs on a scratch copy whose root `node_modules` links each workspace package (root `workspaces` and `pnpm-workspace.yaml`).
- **Per-file tsconfig.** Each file is cruised with the tsconfig that owns it: the closest `tsconfig.json` that includes it, else the root one.
- **Conditions.** That tsconfig's `customConditions` are passed as `conditionNames`.
- **Still never run.** Nothing is installed, built or run. Third-party packages stay absent.

**Classifier rules added.** Each one was checked against the tools, not assumed:

- **Unbuilt workspace output.** A workspace import the linked tool still cannot resolve (its exports point at output that isn't built, under the importer's own conditions) counts as Epoch right only if Epoch's target is one of that package's own `exports` for the subpath. TypeScript's `.ts` face of a `.js` target counts.
- **Two exported files.** Two different files that the package exports for one subpath are _ambiguous_: which one applies depends on the conditions in effect.
- **paths without baseUrl.** A tsconfig `paths` alias without `baseUrl` is the tool's limit. TypeScript allows this since 4.1, and dependency-cruiser applies `paths` only with a `baseUrl` (checked: the same tsconfig with a `baseUrl` added resolves).

**Results** (raw = the tool as truth):

| Repository                                                  | Before: raw precision / recall | After: raw precision / recall | After: adjusted |
| ----------------------------------------------------------- | ------------------------------ | ----------------------------- | --------------- |
| zod `680d19f7`                                              | 66.6% / 100.0%                 | 93.4% / 100.0%                | 100.0% / 100.0% |
| vitest `2899eb3e`                                           | 55.2% / 99.2%                  | 94.3% / 99.3%                 | 100.0% / 100.0% |
| vuejs/core `0ff253bf` (held out: never used to design this) | not measured                   | 100.0% / 100.0%               | 100.0% / 100.0% |

**Epoch fixes it revealed.** A `/// <reference types="…">` naming a workspace package was skipped, on the assumption that package names are third-party type packages. It now resolves like an import: a type-only edge to the workspace source, or an external package (conformance case `triple-slash-types-workspace`; TS adapter version 8).

## Sources

- https://github.com/sourcegraph/scip-typescript (README: installation and usage)
- https://github.com/sourcegraph/scip-python (README: "Environment")
- https://github.com/microsoft/pyright/blob/main/docs/import-resolution.md ("Resolution Order", "Configuring Your Python Environment", editable installs)
- https://docs.python.org/3/library/site.html (`.pth` files and `sitecustomize` run at start-up)
