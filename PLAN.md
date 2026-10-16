# PLAN.md: build plan for Epoch

`CLAUDE.md` says WHAT Epoch is, the rules, and the data contracts. This file says HOW to build it, in what order, and how to prove each step is correct. Precedence: CLAUDE.md > ADRs > this file. If something here conflicts with CLAUDE.md, stop and ask. Never silently diverge: if a rule or contract must change, propose the CLAUDE.md edit and its ADR together, get my approval, and commit them together.

## How to use this file (read first)

You are the build agent. Work in plan mode first, then implement, one milestone at a time.

**Plan-mode procedure (every milestone):**
1. Read `CLAUDE.md`, this file, and `docs/decisions/*`. Inspect the current repo state (read-only).
2. Find the NEXT milestone with unchecked boxes. Plan only that milestone. Never plan or build ahead.
3. Produce a plan in this format and stop for approval:
   - **Goal** (one sentence)
   - **Spec refs** (the CLAUDE.md sections you are implementing)
   - **Assumptions** (anything not stated in CLAUDE.md or here)
   - **Files to create or modify** (exact paths)
   - **Types and interfaces** to add (signatures only)
   - **Order of work**, tests first, in small steps
   - **Verification**: the exact commands and checks that prove it works
   - **Risks** and how you'll handle them
   - **Open questions** for me (only what blocks the work; park the rest)
4. Do not write code until I approve the plan.

**Implementation rules:**
- Tests first for anything touching graph correctness, the finding rubric, or cache invalidation: write the fixture and a failing test, then the code.
- Small commits, conventional commit messages, one logical change each.
- In the milestone's final commit, tick the checkboxes in this file and write each ADR the milestone lists (register below). Update CLAUDE.md only if a rule or contract changed, and only with my approval.
- Never weaken, skip, or delete a test to make it pass. If a test is wrong, say so and explain.
- Never fabricate numbers. Every benchmark figure comes from a script in the repo that I can re-run. If something wasn't measured, write "not measured".
- Do not guess external API shapes, SDK function names, package APIs, or prices. Read the current official docs at implementation time, cite the page in the ADR or code comment, and pin versions.
- Stop at each **Gate** and wait for me.

**Definition of done for any task:** typecheck, lint, and tests pass; no `any` without a comment; new behavior has tests; public interfaces documented; any new network call added to `docs/privacy.md`; no CLAUDE.md rule violated.

## Traceability: MVP items to milestones

| CLAUDE.md MVP item | Milestone | Main CLAUDE.md sections |
|---|---|---|
| Core, adapter interface, TS/JS adapter, CLI | M1 | Data contracts, Edge traversal policy, Barrel transparency rule, Language adapter interface |
| Cache, incremental analysis, accuracy benchmarks | M2 | Local cache, Testing and accuracy |
| Desktop app, graph UI, Python adapter | M3 | Architecture, Electron security, App UX basics |
| Watcher, blast radius, churn, coverage, risk, Go adapter | M4 | Blast radius, Risk score, Edge traversal policy |
| Dead-feature detection and alerts | M5 | Dead-feature detection (all subsections) |
| Hint edges, scorers, evaluation | M6 | RelationScorer, Edge traversal policy |
| Keys, cost guardrails, summaries, offline | M7 | Privacy and data flow, Bring your own keys |
| Installers, release, demo site, README | M8 | Distribution, Definition of done for MVP |

## ADR register

Write each ADR in `docs/decisions/` as `ADR-00N-title.md` (context, options, measured evidence, decision, consequences).

| ADR | Milestone | Decision |
|---|---|---|
| ADR-001 | M0 | Project name and license |
| ADR-002 | M1 | tree-sitter grammar sourcing; pin `web-tree-sitter` and grammar WASM versions together |
| ADR-003 | M1 | Barrel tracing: tree-sitter plus own re-export tracing vs full `ts.Program` with the type checker (decide by measuring both on one real repo) |
| ADR-004 | M2 | Cache design: cache `FileFacts`, recompute resolution each run; when (if ever) to add resolution caching |
| ADR-005 | M3 | Electron vs Tauri |
| ADR-006 | M3 | Precision upgrades (SCIP, language-native tooling). Must address CLAUDE.md principle 8: anything that runs project-controlled code is rejected unless sandboxed |
| ADR-007 | M5 | Findings: flag pattern sources, entry-point rules, framework list, history strategy and cost, `staleAfterDays` default, any rubric tuning |
| ADR-008 | M6 | Local embedding model and the default hint threshold for "likely" mode |
| ADR-009 | M7 | Keychain library for the CLI |
| ADR-010 | M0 | Toolchain baseline: Node 24, pnpm 11, TypeScript 6 (not 7), Turborepo settings and telemetry off, compiled packages, CI on Linux, macOS and Windows |
| ADR-011 | M1 | `churn90d` and `riskScore` are optional and absent until computed (M4), like `coverage` |
| ADR-012 | M3.5 | Optional 3D overview: own renderer on three.js and d3-force-3d (the ready-made library violates the CSP); measured layout time, frame rate and picking |
| ADR-013 | M4 | Go: packages as `pkg:` nodes (tests stay file nodes), go.mod/go.work resolution read as data, build tags not evaluated; measured against `go list` |
| ADR-014 | M6 | `FileFacts.strings`: key-like literals (event names, routes, topics, config keys) for shared-string hints; a CLAUDE.md contract change |

## Questions to ask me

**Before M0:**
1. Final project name: resolved, Epoch (ADR-001); "Axon" was the working title.
2. License (MIT? Apache-2.0? other).
3. Which OS am I developing on? (Affects native-module and packaging testing.)
4. Do I have Jev early access yet? If not, build the interface and mark Jev benchmarks "not run".
5. Is the GitHub repo public? (Assume yes; affects CI, releases, and demo-data licensing.)

**At M5 planning (ask in the plan, don't assume):**
1. Which vendor flag SDKs besides OpenFeature should get pattern packs? Do I have target repos that use feature flags to test on?
2. What precision bar do I want for High-confidence findings on the reviewed sample? (My suggestion: at least 90%. It is my call, not yours.)
3. Is 90 days a good default for `staleAfterDays`?

## Scope-cut order (if time runs short, cut in this order)

1. Linux installers. 2. `JevScorer`. 3. `LocalScorer` and embeddings (keep heuristic hints). 4. `stale-flag` findings (keep `dead-branch` and `unreachable-file`). 5. The Go adapter (and its M5 work).

Never cut: the conformance suite, the equivalence property test, the Electron security tests, the offline test, the benchmark scripts, or honesty about measured results.

---

## M0: Pre-flight and scaffold

**Goal:** an empty but fully wired monorepo with green CI.
**Spec refs:** Repo layout, Conventions.

- [x] Resolve the pre-M0 questions. ADR-001.
- [x] pnpm workspace + Turborepo. Base `tsconfig` with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- [x] ESLint + Prettier, Vitest, `.editorconfig`, `.gitignore`, `.env.example`.
- [x] Package skeletons: `packages/core`, `packages/adapters/typescript`, `packages/findings`, `packages/engine`, `packages/cli`. Each has build, test, and lint scripts.
- [x] GitHub Actions: lint, typecheck, test on push and PR (Linux, macOS, Windows).
- [x] README stub stating the privacy principle and "work in progress". Copy `CLAUDE.md` and `PLAN.md` into the repo root.

**Acceptance:** `pnpm install && pnpm lint && pnpm typecheck && pnpm test` passes locally and in CI, with at least one real test per package.

**Gate:** I review the scaffold.

---

## M1: Core model, TS/JS adapter, headless CLI

**Goal:** `epoch analyze <path> --json` produces a correct file-level dependency graph for TS/JS repos.
**Spec refs:** Data contracts, Edge traversal policy, Barrel transparency rule, Language adapter interface, Known hard problems (TS/JS).

**Tasks**
- [x] **Schemas:** zod schemas in `core` for every type in CLAUDE.md "Data contracts" (types via `z.infer`), plus a canonicalization function (sorted arrays, forward-slash ids, no timestamps or absolute paths) with tests. A `Graph` is validated before it is written or sent.
- [x] **Interfaces (types only):** `LanguageAdapter`, `CacheStore`, `SecretStore`, `RelationScorer`, `GitHistoryProvider`, `EpochApi`.
- [x] **Graph helpers in `core`:** the edge traversal policy as constants, `reverseReachable(graph, nodeId, edgeKinds)`, and strongly connected components. (The full blast radius result comes in M4.)
- [x] **Discover:** walk the repo honoring `.gitignore` (the `ignore` package) and `.epochignore`; skip `node_modules`, `.git`, and build output by default; detect language by extension; detect project roots (`tsconfig.json`, `package.json`, workspaces). Cap file size and record skipped files.
- [x] **Parse:** initialize `web-tree-sitter`; load TS, TSX, and JS grammars. ADR-002. Pitfall: a grammar WASM's ABI must be supported by the runtime; pin both together and add a startup self-test.
- [x] **TS adapter `extract`:** static imports, `import type`, `export ... from`, `export * from`, dynamic `import("literal")`, `import(\`prefix/${x}\`)` (record `dynamicPrefix`), `require("literal")`, side-effect imports; exports; `loc`; `isGenerated`. `flagUsages` and `constantConditions` return `[]` until M5; `detectEntryPoints` returns `[]` until M5; `isTestFile` implemented now.
- [x] **TS adapter `resolveImport`:** TypeScript's module resolution API (`ts.resolveModuleName` with a parsed tsconfig and read-only file access). Handle relative paths, `paths`/`baseUrl`, directory `index`, `.js`-to-`.ts` mapping in ESM TS projects, `package.json` `exports`, `node_modules` packages as `external` (recorded in `externals`, not materialized as nodes), and workspace packages (monorepo siblings are internal). Read tsconfig as data only; never execute project config.
- [x] **Barrel tracing and graph stage:** implement the Barrel transparency rule exactly (edges A→C `import` with evidence `via barrel B`, B→C `reexport`, A→B `via-barrel`; conservative `import` A→B for namespace, side-effect, or untraceable re-exports). Compute fan-in/out and cycles. ADR-003.
- [x] **Conformance harness:** each case is a folder `fixtures/<lang>/conformance/<case>/` with sources and `expected.json` (canonical `Graph` subset). Any adapter must pass the shared cases that apply.
- [x] **CLI:** `epoch analyze <path> [--json]`. Output validates against the schema; progress and warnings to stderr, JSON to stdout; includes the `unresolved` list with reasons.

**Required conformance cases (TS/JS):** relative import; `paths` alias; `baseUrl`; directory `index`; barrel with named re-exports; `export *` barrel; namespace import through a barrel (conservative edge); cycle; external package; monorepo workspace import; dynamic import with literal; dynamic import with variable (`unresolved`, `dynamic-specifier`); dynamic import with literal prefix (`pathPrefix` recorded); `import type` (`type-only`); `.js` extension mapping; `via-barrel` edge present.

**Acceptance (each must be demonstrably true)**
- All conformance cases pass.
- Barrel test (automated): A imports `{Card}` from `components/index.ts`, which re-exports `Button` and `Card`. `reverseReachable` from `Button.ts` using the certain-mode edge kinds does NOT include A. A reachability traversal using all fact kinds DOES reach `components/index.ts` from A.
- Canonicalization test: shuffling input order yields byte-identical canonical JSON.
- `epoch analyze` on the monorepo fixture validates against the schema.
- The CLI runs on one real mid-size TS repo without crashing; report node, edge, and unresolved counts. Do NOT claim accuracy yet.

**Pitfalls:** case-insensitive file systems (macOS/Windows) vs Linux CI path casing; symlink cycles in the walker; `.d.ts` handling; path normalization to forward slashes in node ids; tsconfig `extends` chains.

**Gate:** I review the real-repo run.

---

## M2: Cache, incremental analysis, accuracy benchmarks

**Goal:** accurate on real repos (with measured accuracy), and re-analysis costs proportional to the diff.
**Spec refs:** Local cache, Testing and accuracy.

**Tasks**
- [x] Run on 2 or 3 real TS repos (candidates below). Fix resolution gaps you find, each with a new fixture.
- [x] **Measure accuracy** with `pnpm bench:accuracy <repo>` against a ground-truth tool (table below): precision and recall for file-level import edges, with disagreements classified (tool wrong, we're wrong, ambiguous or dynamic). Write to `docs/benchmarks/typescript.md` with method, repo SHAs, and tool versions.
- [x] **CacheStore (SQLite, `better-sqlite3`)** in `engine`: WAL mode, schema versioning with migrations, owner-only permissions, location from the shared resolver in `core`. ADR-004.
- [x] **Cache `FileFacts`** keyed by hash(contents + adapter id + adapter version + `extractorConfigHash`). Plumb `extractorConfigHash` now (constant until M5 gives it content). **Recompute resolution, graph, and findings every run** from cached facts. Never store file contents or code excerpts.
- [x] **Incremental:** change detection via `git diff` against the last analyzed commit, with a content-hash fallback for non-git folders; per-repo index stores the manifest and last commit; handle uncommitted changes.
- [x] **Early cutoff mechanism** for downstream outputs (used by M6/M7 scores and summaries): generic "if the recomputed input equals the previous one, stop propagating", tested with a stub.
- [x] CLI: `--since <commit>`, `epoch cache stats|clear|prune`, size cap with LRU eviction.
- [x] **`pnpm bench`:** copies a repo to a temp dir, applies 1, 5, and 50-file edits, and reports cold full, warm unchanged, and incremental times, including how long resolution takes (ADR-004 uses this to decide whether resolution caching is ever needed). Median of at least 5 runs, hardware recorded. Results to `docs/benchmarks/`.

**Acceptance**
- Re-running on unchanged input is a 100% cache hit for `FileFacts`.
- **Equivalence property test (the key correctness test):** for random edit sequences on fixtures (modify, add, delete, rename files; change tsconfig), the incremental canonical `Graph` is identical to a full recompute from scratch.
- A test scans the cache database and finds no fixture source lines (no file contents or code excerpts).
- Accuracy numbers exist in `docs/benchmarks/typescript.md`, produced by the script.

**Pitfalls:** SQLite concurrency when the CLI and app run at once (WAL, busy timeout); cache poisoning across adapter version bumps; `git` not installed; shallow clones; renamed files appearing as delete plus add.

**Gate:** I review the benchmark report.

---

## M3: Electron shell, UI, Python adapter

**Goal:** a secure desktop app that opens a folder and shows the graph; Python is the second adapter.
**Spec refs:** Architecture, `EpochApi`, Electron security, App UX basics, Known hard problems (Python).

**Tasks**
- [x] ADR-005 (Electron vs Tauri) and ADR-006 (precision upgrades; before writing the Python adapter).
- [x] Electron via `electron-vite`: main, preload, renderer. The analysis host is a `utilityProcess` using a `piscina` worker pool. Heavy work never runs in main or renderer.
- [x] `EpochApi` implemented over IPC (zod-validated payloads, sender verification, no generic channels) plus a static-JSON stub for the future demo site.
- [x] **Security config and tests first**, before feature work: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, no remote content, navigation and `window.open` denied, external links via allowlist to the default browser, path checks restricted to the opened folder (including symlink escape).
- [x] **UI:** open-folder (dialog, drag-drop, recent list), streaming progress, Cytoscape graph with directory compound nodes (collapsed by default for large graphs), layout (fcose or ELK) in a Web Worker, search, node details panel, solid edges for facts and dashed for hints, toggle for `via-barrel` edges (hidden by default).
- [x] **Python adapter** (`extract`, `resolveImport`, `isTestFile`; flags, constants, and entry points come in M5): absolute and relative imports, `__init__.py` packages, namespace packages, src layouts and `pyproject.toml` roots, stdlib vs third-party vs internal (bundle a stdlib module list; `sys.stdlib_module_names` exists only on Python 3.10+, so don't depend on a runtime Python), `from . import x` ambiguity (submodule vs name). Conformance cases for each.

**Acceptance**
- Playwright e2e: open a fixture folder, graph renders, clicking a node shows details.
- Security tests: renderer has no `require` or Node access; external navigation blocked; unknown IPC channel and invalid payload rejected; a path outside the project (including via symlink) rejected; analyzing a fixture with malicious scripts and config executes nothing.
- Python conformance passes; Python run on one real repo reports counts.
- A packaged build (even local, unsigned) launches and analyzes a fixture. Do this now, not in M8.

**Pitfalls:** `better-sqlite3` and the WASM grammar files must be rebuilt or unpacked for Electron (`asarUnpack`) and loaded by a path that works in dev and packaged builds; the renderer must not accidentally bundle Node modules.

**Gate:** I run the app and review.

---

## M3.5: UX pass (from the M3 gate review)

**Goal:** any file can be understood from its neighbors, and the app looks and behaves like a desktop app, not a web page in a window. Added after the M3 gate review: the graph was hard to digest and the window felt like a web page.
**Spec refs:** App UX basics, Electron security (unchanged), principles 3 and 9, Edge traversal policy (default display set).

**Tasks**
- [x] **Focus view:** the selected file in the center, its imports in columns to the right and its dependents to the left (1–3 hops), crowded columns grouped by folder, animated re-centering, Back/Forward history. Pure `neighborhood()` and `focusLayout()` with unit tests. It follows the default display edge set; beyond one hop the dependents side previews, but is not, blast radius (M4).
- [x] **Neighbors** tab in the inspector; hover highlighting with direction colors in the full graph; color by folder or language; projects open as a folder map (folders open breadth-first within a node budget).
- [x] **Desktop shell:** the UI draws the title bar (macOS inset traffic lights; Windows and Linux native buttons through the Window Controls Overlay, plus a menu button for the hidden menu bar); sidebar with project switcher, views and file tree; resizable inspector; status bar with each language's tier; welcome screen; progress inside the window.
- [x] **Command palette** (⌘K / Ctrl+K) with a tested fuzzy matcher; View menu commands reach the window; one command registry for keys, menu and palette.
- [x] Design tokens shared by chrome and canvas, light and dark. No `webPreferences` change; new IPC (`show-app-menu`, `menu-command`) zod-validated and sender-checked.
- [x] **Optional 3D overview** (after the review of the above): ADR-012 with a measured prototype (CSP compatibility, bundle size, layout time, frame rate and picking on Flask and vitest), then a 2D/3D toggle in the graph view, off by default and lazily loaded. Cytoscape stays the main renderer. Rendering on a real GPU is not measured yet.

**Acceptance**
- Unit tests for the neighborhood, focus layout, fuzzy matching, shortcuts, colors and preferences.
- e2e (dev and packaged, three OSes): the focus view and neighbors, the palette, menu commands, the app-menu channel's payload checks, the window-controls check, and every earlier e2e and security test, with no CSP violations.
- e2e for 3D, with software WebGL: the files are drawn, clicking picks a file, double-clicking opens the focus view, no CSP violations; without WebGL the option is disabled with its reason.

**Gate:** I review the shell and the focus view (done), then the 3D overview; then M4.

---

## M4: Watcher, blast radius, risk score, Go adapter

**Goal:** the core value, blast radius with risk, live as files change.
**Spec refs:** Blast radius, Risk score, Edge traversal policy, Known hard problems (Go).

**Tasks**
- [x] **Watcher** (`chokidar`) in the analysis host: debounce and batch events, respect ignore rules, handle renames and editor temp/swap files, and mass changes (branch switch) by falling back to a git-diff-driven re-analysis. Feeds the M2 incremental path and emits `onGraphDelta`. (chokidar 5.0.0; batches of 300 ms quiet, 2 s at most; only directories Discover walks are watched; HEAD is polled, and a moved HEAD re-reads `git diff` paths; the OS watch limit stops watching with a clear message. Main applies the deltas, so `getGraph` stays current.)
- [x] **Blast radius** in `core`: reverse BFS over the traversal policy, cycle-safe; certain and likely modes (likely arrives usable in M6); type-only toggle; results: total affected, max depth, grouping by directory and language, count depending on hint edges. UI highlight with depth control. (Impact tab and Blast radius toggle; packages and files counted separately.)
- [x] **Git churn** in `engine`: last 90 days of `git log` with machine-readable output (`-z`, rename detection); skip merge commits; warn on shallow clones. (The window ends at HEAD's commit date, so the graph stays a function of the repository.)
- [x] **Coverage ingestion:** lcov and Cobertura XML parsers; map to repo-relative paths (strip CI absolute prefixes). (Conventional report paths in the project, or `--coverage` in the CLI.)
- [x] **Risk score** per the CLAUDE.md formula (percentile rank, reweight when coverage is missing, deterministic ties); UI breakdown of each component. (No git history: no score, and the UI says why; Color by Risk.)
- [x] **Go adapter** (`extract`, `resolveImport`, `isTestFile`): `go.mod` module path, import path to package directory, packages as nodes (`kind: "package"`, `id: "pkg:..."`), `internal/` rules, `_test.go`, `vendor/`, `go.work`. Build tags are not evaluated (and not recorded: `FileFacts` has no field for them); the accuracy report measures the cost. Conformance cases. (ADR-013: 15 conformance cases checked against `go list`; test files stay file nodes linked to their package.)
- [x] **Accuracy of Python and Go** against ground-truth tools (added to M4): Python vs grimp 3.17 on Flask 3.1.3, Go vs `go list` on cli/cli v2.82.0. Both met the tier A bar (precision and recall at least 95%, every disagreement explained) and moved to tier A. Python's raw precision is 71.6%: grimp does not see Flask's `sansio` namespace subpackage (`docs/benchmarks/python-accuracy.md`).

**Acceptance**
- Blast radius tests on fixtures: chain, diamond, cycle, the M1 barrel case, type-only toggle, `via-barrel` excluded, certain vs likely.
- Watcher e2e: editing a file updates the graph; a branch-switch simulation matches a full recompute.
- Risk score unit tests with hand-computed expected values.
- Go conformance passes; Go run on one real repo reports counts.

**Pitfalls:** watcher event storms; OS watch limits on large repos (surface a clear error); Go package vs file granularity in blast radius counts (report both clearly).

**Gate:** I review.

---

## M5: Dead-feature detection and alerts

**Goal:** a correct, honest, alert-first dead-feature report for TS/JS, Python, and Go.
**Spec refs:** Dead-feature detection (all subsections), Confidence rubric, `epoch.config.json`, Alerts and review, Data contracts (`FileFacts`, `FlagUsage`, `ConstantCondition`, `Finding`, `FlagPattern`, `GitHistoryProvider`), Edge traversal policy (reachability row).

**Tasks**
- [x] **ADR-007** (flag pattern sources, entry-point rules, framework list, history strategy and measured cost, `staleAfterDays` default, rubric tuning). Ask the M5 questions first.
- [x] **Config loader** in `engine` for `epoch.config.json`: zod validation, size cap, unknown keys warn, JSON only, never written. Globs through a glob matcher; `envPrefixes` are plain prefix matches. Feeds `ExtractorConfig` and its hash.
- [x] **Pattern packs** in `packages/findings/packs/` (data, zod-validated; every entry requires a `source` docs URL). Start with OpenFeature plus the vendor SDKs I choose, for each supported language. Read the official docs for each; do not use memory.
- [x] **Adapters (TS/JS, Python, Go):** implement `extract` for `flagUsages` (pattern match with `strong`/`weak` by import evidence; user wrappers and env reads are `strong`; non-literal keys give `flagName: null`) and `constantConditions` (literal conditions; never-reassigned boolean constants at local, module, and exported scope used as conditions; exclusion of typing-only guards and environment-derived values), and `isGenerated`. `detectEntryPoints` per language: TS (`package.json` `main`/`module`/`bin`/`exports` mapped from build output back to source using tsconfig `outDir`/`rootDir`, files referenced by `scripts`, config files, conventions, `entryPoints` from config), Python (`__main__.py`, `if __name__ == "__main__"`, console-script entries in `pyproject.toml`, `manage.py`/`wsgi.py`/`asgi.py`), Go (`package main`). Test files are roots. If a manifest entry cannot be mapped to source, record it as unmapped (this triggers the Medium cap).
- [x] **Framework detection** (data list from ADR-007): mark convention directories; show the notice.
- [x] **`GitHistoryProvider` in `engine`:** report `usable`/`reason` (not a repo, shallow, history shorter than `staleAfterDays`); `firstIntroduced` and `lastTouched` scoped to the files that contain the flag; uncommitted lines count as "now"; honor a `.git-blame-ignore-revs` file if present (verify the flag in git's docs); cache lookups by path and blob hash; measure cost on a real repo and record it in ADR-007.
- [x] **Detectors in `findings`** (pure; take `Graph`, `FileFacts`, `GitHistoryProvider`, config): `dead-branch`, `stale-flag`, `unreachable-file`, exactly per the CLAUDE.md rubric. Stable ids with no line numbers. Evidence, caveats, suggested action text, and `caps` recorded on every finding. Run as the last pipeline stage.
- [x] **Dismissals store** in `engine` (Epoch app data, per project, keyed by finding id, optional note).
- [x] **UI:** non-modal alert banner, Findings panel (filters, sorting, dismiss/undismiss), node badges and graph filter, node panel evidence/caveats/suggested action with a read-only code preview (via `getCodePreview`, inside the project root), notices for unusable history and for detected convention frameworks, and the "unassessable flag usages" count.
- [x] **CLI:** `epoch findings` with `--json`, `--min-confidence`, `--fail-on`, `--include-dismissed`, and exit codes 0/1/2.
- [x] **Docs:** `docs/findings.md` (kinds, rubric, configuration, limits, how to reduce false positives).
- [x] **Evaluation, `pnpm bench:findings <repo>`** (protocol below).
- [x] Extend the equivalence property test to include findings.

**Findings fixtures** (`fixtures/<lang>/findings/<case>/` with `expected` findings; use a fake `GitHistoryProvider` for git-dependent cases):
- *dead-branch:* literal `false` condition (High); local const (High); module const (High); exported const (Medium); reassigned variable (none); Python `TYPE_CHECKING` guard (none); Go `const debug = false` (Low); environment-derived value (none); debug-like name (Low).
- *stale-flag:* strong usage, old and untouched (Medium); weak-only (Low); recently touched (none); recently introduced (none); in `longLived` (none); dynamic key (none, counted as unassessable); shallow history (none, notice); non-git folder (none, notice).
- *unreachable-file:* orphan with manifest roots, old, git usable (High); same orphan with no git (Medium); dynamic-prefix coverage (Low); internal barrel whose importers are all traced (NOT reported); test file (not reported); generated file (not reported); manifest `main` root; script-referenced root; Go `package main`; Python console-script root; config `entryPoints` glob; unreachable cycle (both files reported as a group); file reachable only through a `type-only` import (reachable); convention-directory in a detected framework (Low).
- *hint cap:* added in M6.

**Acceptance**
- All findings fixtures pass in TS/JS, Python, and Go, including every cap in the rubric, and no `stale-flag` finding ever has High confidence (property test).
- Finding ids are stable across edits that only move lines (test); dismissals persist across restarts.
- No finding is emitted without evidence and at least one caveat; UI strings never describe a finding as certain (test on the strings).
- The banner appears only for non-dismissed High/Medium findings; `epoch findings --fail-on high` exits 2 on a fixture with a High finding and 0 otherwise.
- `bench:findings` produces `docs/benchmarks/findings.md` with every limit stated.
- The equivalence property test still passes with findings included.

**Evaluation protocol (`bench:findings`)**
1. **Comparison:** TS/JS `unreachable-file` vs a unused-files report from an existing tool (knip; verify version and flags). Classify disagreements. No comparable file-level tool is assumed for Python or Go.
2. **Hindsight test:** check out a historical commit T of a real repo into a temp worktree, analyze, then at HEAD check what happened: for `unreachable-file`, was the file deleted? For `stale-flag`, do the call sites still exist? Report rates per confidence level next to the baseline rate for unflagged items. State plainly that this is a proxy (many dead things are never removed; some live things are deleted).
3. **Human review:** generate `docs/benchmarks/findings-review.csv` with up to 50 sampled High and Medium findings (stratified by language and kind) with repo links, evidence, and an empty `verdict` column. I fill the verdicts; do NOT fill them yourself. A script computes precision per confidence level. (2026-10-16: at my request, Claude filled the verdicts instead, checking each finding at its pinned commit; the reports label them as Claude's, not a human's. See ADR-007 "Rubric tuning".)
4. If High-confidence precision on the reviewed sample is below the bar I set, tune the rubric by tightening caps (record it in ADR-007) and re-run before the gate.

**Pitfalls:** pickaxe/blame cost on large histories (scope to files containing the flag; measure); mass-reformat commits make everything look recently touched (honor the blame ignore file); monorepo packages with several manifests; files used only by non-code (Dockerfile, templates, CI scripts) will look unreachable (the caveat text says so); renamed or moved files losing history.

**Gate:** I review `docs/benchmarks/findings.md` and the review sheet results. (Passed 2026-10-16: I accepted Claude's review and the tuned rubric; see ADR-007.)

---

## M6: Hint edges and scorers

**Goal:** measured, calibrated hint edges clearly separated from facts, feeding blast radius "likely" mode and finding caps.
**Spec refs:** RelationScorer, Edge traversal policy, Blast radius, Confidence rubric (hint cap).

**Tasks**
- [x] **Co-change hints** from commit file-sets: skip merge commits and very large commits (configurable cutoff); compute support and conditional confidence P(B|A); minimum-support threshold; evidence like "changed together in 42 of 51 commits".
- [x] **Shared-string hints:** extract literals that look like event names, routes, topics, and config keys; inverted index weighted by rarity so common strings don't link everything.
- [ ] **Local embeddings** via ONNX/transformers.js for candidate generation (nearest neighbors, never all-pairs), cached by content hash. ADR-008: model choice (size, quality, license, CPU speed, measured) and the default hint threshold for "likely" mode.
- [ ] **`RelationScorer` implementations:** `HeuristicScorer` (baseline, offline default), `LocalScorer`, `JevScorer`, `LlmScorer`. For Jev read its current docs (docs.typesafe.ai); it needs the user's own key. Without access, keep the stub and mark results "not run".
- [x] **Finding caps from hints:** in the `findings` rubric, a candidate with a hint edge to a reachable file at or above the default threshold is capped at Medium and lists the hint in caveats.
- [x] **Evaluation `pnpm bench:scorers`:** temporal holdout. Use history up to time T to propose hint edges, then check whether the linked files co-change after T. Precision/recall at thresholds and calibration (reliability diagram, ECE) per scorer, method and limits documented in `docs/benchmarks/scorers.md`.
- [x] **UI:** hint-edge toggle, confidence slider, evidence on hover; blast radius "likely" mode uses the slider.

**Acceptance:** the harness produces a report; `HeuristicScorer` is the baseline for all others; no hint edge is emitted without evidence; scorers never change fact edges or findings except through the documented cap (test both); the hint-cap fixture passes.

**Pitfalls:** evaluation leakage (never use post-T data to propose); giant monorepos make co-change noisy; model outputs that cite nonexistent symbols (verify against the parse tree before display).

**Gate:** I review the scorer report.

---

## M7: Keys, cost control, summaries, offline mode

**Goal:** opt-in model features that are safe, cost-aware, and provably absent when offline.
**Spec refs:** Privacy and data flow, Bring your own keys, Local cache (summaries, early cutoff).

**Tasks**
- [ ] `SecretStore` implementations: Electron `safeStorage` for the app (check encryption availability; on Linux check the selected backend and warn if weak), OS keychain or env vars for the CLI (ADR-009; must be a maintained library). Settings → Keys UI; the renderer only learns "configured or not".
- [ ] LLM provider interface (Anthropic first). Token usage from the API's reported usage. Pricing is user-configurable data with no prices hardcoded from memory.
- [ ] **Cost guardrails:** estimate before bulk jobs, confirmation above a threshold, spend cap (`--max-spend` and settings), running cost display.
- [ ] **Consent flow:** first use of any remote model feature shows exactly what will be sent; secret-pattern files are never sent even with consent.
- [ ] **Lazy summaries:** prompt grounded in file source plus neighbor summaries; cached; hierarchical (directory summaries from child summaries); invalidated through the early-cutoff mechanism. Text LLM or local model, never Jev.
- [ ] **Offline mode:** setting and `--offline`. Enforce through the single network wrapper (main and analysis host) and at the Electron session level; disable update checks.

**Acceptance**
- Zero-network test: a full analysis with outbound network blocked makes no requests (CI step).
- Secrets test: no key value appears in logs, cache, exports, or renderer-accessible state (automated scan).
- Spend cap enforced against a mocked provider.
- Consent flow test: nothing is sent before consent; secret files are excluded.

**Gate:** I review.

---

## M8: Packaging, release, site, README

**Goal:** installers anyone can download, and a README that sells the project honestly.
**Spec refs:** Distribution, Definition of done for MVP.

**Tasks**
- [ ] `electron-builder` config for macOS (dmg), Windows (NSIS), Linux (AppImage/deb). `asarUnpack` for native modules and WASM. Verify on a packaged build per OS.
- [ ] GitHub Actions release matrix (one runner per OS so native modules build correctly); tagged releases publish to GitHub Releases.
- [ ] Auto-update with opt-out, listed in the data-flow table.
- [ ] Signing: ship unsigned early builds with first-run instructions; document the status. Ask me before spending money on signing.
- [ ] **Site** (`apps/site`): landing page, downloads, and an in-browser demo viewer using the static `EpochApi`, with graphs and findings precomputed by the CLI for public OSS repos (record repo, SHA, and license/attribution). No backend, no model features.
- [ ] **README:** problem, demo GIF, architecture diagram, privacy model and data-flow table, how findings work with their limits and measured precision, tradeoffs, signing status, and benchmark tables copied from `docs/benchmarks/` (never retyped).
- [ ] Final smoke test on a clean machine or VM per OS: install, open a real repo, blast radius, findings banner, offline mode.

**Acceptance:** CI-built installers for macOS and Windows (Linux if time) from a tag; clean-machine smoke test passes; every README number traces to a script.

---

## Post-MVP backlog (do NOT start; each item needs an approved CLAUDE.md update first)

Removal assistance (patch export for high-confidence mechanical findings), unused exports, "reachable only from tests" findings, `FlagSource` provider integrations, load testing, OpenTelemetry traces, more languages, VS Code extension, open-in-editor, comment directive to suppress findings, Tauri re-evaluation. Details are in CLAUDE.md v2.

---

## Benchmark protocol (applies to every number we publish)

- Pin repo URL and commit SHA. Record hardware, OS, Node version, and tool versions.
- Say whether the cache was cold or warm. Median of at least 5 runs.
- Scripts live in the repo and write results to `docs/benchmarks/*.md`; docs and README quote those files.

**Candidate benchmark repos (verify size and license, then pin SHAs):**

| Language | Small | Mid | Stress (optional) |
|---|---|---|---|
| TS/JS | zod | vitest (monorepo) | TypeScript compiler |
| Python | requests | flask, fastapi | django |
| Go | cobra | gin | kubernetes |

**Ground-truth and comparison tools (verify versions and flags when used):**

| Purpose | Language | Tool |
|---|---|---|
| Edge accuracy | TS/JS | dependency-cruiser; `tsc` file lists for sanity checks |
| Edge accuracy | Python | grimp (import graph used by import-linter) |
| Edge accuracy | Go | `go list` with JSON output of imports |
| Unreachable-file comparison | TS/JS | knip (unused files report) |

Always classify disagreements (tool wrong, we're wrong, ambiguous or dynamic) before quoting precision or recall.

## Risk register

| Risk | Mitigation |
|---|---|
| Resolution inaccuracies undermine the whole pitch | Conformance suite, ground-truth benchmarks, `unresolved` with reasons, tiers in UI |
| Dead-feature false positives erode trust | Fixed rubric with caps, "candidate" wording, caveats on every finding, dismissals, config for entry points, human-reviewed precision, High never assigned to `stale-flag` |
| Git history is unreliable (shallow, squashed, mass reformat, renames) | Detect and report unusable history, skip `stale-flag` then, honor the blame ignore file, cap confidence |
| History queries are slow on big repos | Scope to files containing the flag, cache by blob hash, measure in ADR-007 |
| Large repos are slow or the graph is unreadable | Worker pool, `FileFacts` caching, directory collapsing, measured ceilings before switching renderers |
| WASM/native modules break in packaged Electron | Packaged build tested in M3, `asarUnpack`, per-OS CI |
| tree-sitter runtime/grammar ABI mismatch | Pin versions together, startup self-test |
| Jev access delayed or API changes | `RelationScorer` interface, heuristic and LLM fallbacks, mark "not run" |
| Scope creep (languages, findings, hints, load tests) | MVP/v2 boundary, milestone gates, scope-cut order, no building ahead |
| Surprise costs for users | Estimates, confirmations, spend cap, model features off by default |
| Unsigned installers scare users | Document first-run steps; decide on signing before a public launch |

## Kickoff prompts (copy and paste into Claude Code in plan mode)

**Start:** "Read CLAUDE.md and PLAN.md. Ask me the pre-M0 questions, then plan M0 only, in the plan format from PLAN.md. Don't write code until I approve."

**Each next milestone:** "M(n-1) is approved and merged. Read CLAUDE.md, PLAN.md, and the ADRs. Plan M(n) only, in the PLAN.md plan format, starting with open questions. Don't write code until I approve."

**Mid-milestone check:** "Compare the current repo against the acceptance criteria for the current milestone in PLAN.md. List each criterion as met, unmet, or untested, with evidence (test name or command output). Don't change code."

**Before a gate:** "Run all verification commands for this milestone and summarize the results. Tick the checkboxes in PLAN.md. List any deviations from the plan and the ADRs you wrote."

**Consistency audit (run any time, or after editing either file):** "Read CLAUDE.md and PLAN.md. List every contradiction, stale reference, or term used differently between them (type names, milestone tags, ADR numbers, command names, file paths). Don't edit anything; report findings."
