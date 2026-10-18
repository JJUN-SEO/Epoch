# Epoch

A local-first desktop app (macOS, Windows, Linux) that parses a codebase in most major languages into an interactive dependency graph (nodes connecting like neurons), rates each file's risk in tiers, shows the blast radius of changing any file, alerts you to likely-dead features (constant branches, stale feature flags, unreachable files), and keeps itself up to date cheaply as the repo changes.

Open a project folder in the app and it analyzes it. Your code never leaves your machine by default, and Epoch never modifies your project.

This is a portfolio project. Priorities: a working app on real open source repos; an architecture I can explain in an interview; measured results (parse time, incremental update time, edge accuracy, finding precision, token cost, scorer calibration). Never fabricate numbers. Measure them.

## Document map and precedence

- **CLAUDE.md** (this file): what Epoch is, the rules, and the data contracts. Source of truth.
- **PLAN.md**: build order, tasks, acceptance criteria, gates, and the ADR register. It implements this file.
- `docs/decisions/` ADRs. `docs/privacy.md` data-flow table. `docs/findings.md` finding kinds, rubric, and configuration. `docs/benchmarks/` generated reports.

Precedence: CLAUDE.md > ADRs > PLAN.md. If they conflict, stop and ask. A change to a rule or contract in this file is proposed together with its ADR, approved by me, and committed in the same commit as the change that needs it. Never silently diverge.

## Core design principles

1. **Local-first.** Source code, the graph, and the cache stay on the user's machine. No accounts, no hosted backend, no HTTP server, no telemetry, no uploading projects. The only network calls are the ones in the data-flow table, and every model call is opt-in.
2. **Read-only on projects.** Epoch never creates, edits, or deletes files inside an analyzed project. It writes only to its own cache and settings, and to files the user explicitly exports.
3. **Facts vs hints.** Every edge has a provenance and a confidence. Resolver-proven edges are facts (solid lines in the UI). Everything inferred is a hint (dashed lines, with score and evidence).
4. **Deterministic first.** Structure and findings come from parsers, resolvers, and git, not from models. Models never create fact edges or findings.
5. **Models only where code can't answer.** Probabilistic scoring and prose summaries are the only model uses. Model-proposed relations are verified against something checkable or labeled as hints.
6. **Candidates, not verdicts.** Dead-feature findings are "likely dead, please review", never "dead". Every finding carries evidence, caveats, and a confidence level from a fixed rubric. UI and docs use the words "candidate", "likely", or "stale", never "dead" as a fact.
7. **Cache everything, incrementally.** Extraction results are content-addressed and cached locally. Updating after a change costs proportional to the diff, not the repo.
8. **Parse, never execute.** Analyzing a repo must never run its code, scripts, or config. Treat every opened project as untrusted input, including `epoch.config.json`.
9. **Honest about coverage.** Each language adapter declares a support tier. The UI shows what is resolved precisely and what is best-effort. Do not claim more than tests prove.

## Scope

### MVP (each item is tagged with its milestone in PLAN.md)
1. **[M1]** Language-agnostic core, adapter interface, TypeScript/JavaScript adapter, headless CLI (`epoch analyze`).
2. **[M2]** Local content-addressed cache, incremental analysis, accuracy benchmarks.
3. **[M3]** Electron desktop app: open folder, graph UI, secure IPC. Python adapter.
4. **[M4]** File watcher, blast radius, git churn, coverage ingestion, risk tiers. Go adapter.
5. **[M5]** Dead-feature detection and alerts across TS/JS, Python, and Go.
6. **[M6]** Hint edges (co-change, shared strings, embeddings), `RelationScorer` backends, evaluation.
7. **[M7]** Bring-your-own keys, cost guardrails, opt-in summaries, offline mode.
8. **[M8]** Installers, release pipeline, static demo site, README.

### Language support tiers

**Tier A: precise resolution.** Imports resolved the way the language really resolves them (module system, config files, workspace layout). Rollout order: TypeScript/JavaScript, Python, Go, then Java/Kotlin, C#, Rust.

**Tier B: syntactic best-effort.** tree-sitter extracts imports, then conventional heuristics resolve them. Edges carry lower confidence. Ruby, PHP, Swift, C/C++, Scala, and anything else with a tree-sitter grammar.

MVP target: Tier A for TS/JS, Python, Go. Others are v2. Adding a language must mean writing one adapter, not touching core.

### v2 (do NOT start until the MVP is shipped and I approve a CLAUDE.md update)
- **Removal assistance:** for high-confidence mechanical findings (collapse a constant branch, delete an unreachable file), generate a unified diff the user saves via an export dialog and applies themselves (e.g. `git apply`). Epoch still never writes into the project.
- Unused exports (symbol-level), and "reachable only from tests" findings.
- Flag-provider integrations behind a `FlagSource` interface (compare code against provider state), any vendor.
- Load testing: run k6 against a Dockerized copy of the user's app on their own machine, overlay latency and error rate on the graph. Runtime trace ingestion (OpenTelemetry).
- More SDLC integrations (Azure DevOps, GitHub Actions).
- Remaining Tier A languages; build-system-aware C/C++ (via `compile_commands.json`).
- VS Code extension, open-in-editor, a comment directive to suppress findings in code.
- Re-evaluate Tauri (see Tech stack).

### Non-goals
- A hosted web app, SaaS, accounts, team sharing, or storing user source code on any server we run.
- Telemetry of any kind.
- Modifying or deleting files in analyzed projects.
- Perfect resolution in every language. Tiers exist so we can be honest.
- Declaring anything "dead" with certainty. Static analysis cannot see reflection, tooling outside the analyzed languages, or runtime configuration.
- Predicting load breakage from static code structure alone.
- Competing with Nx graph, CodeScene, Sourcegraph, or Datadog on breadth. The wedge: blast radius + dead-feature alerts + honest confidence + code never leaves your machine, across languages.

## Architecture

Electron app with three processes. There is no HTTP server; the UI talks to the backend over typed IPC.

```
Epoch (Electron)
 ├─ Renderer (React + Cytoscape)   sandboxed, no Node access; talks to main only via a typed preload API
 ├─ Main process                   windows, menus, native dialogs, IPC router, secrets, auto-update
 └─ Analysis host (utilityProcess) pipeline + worker threads (piscina, web-tree-sitter),
                                   SQLite cache, file watcher, git, scorers
Optional outbound: opt-in model providers, update check
```

The UI is written against an `EpochApi` interface. Implementations: IPC (the app) and static JSON (the demo site, which supports only the read-only subset). Pure algorithms (blast radius, reachability, risk, finding rubric) live in `core`/`findings` so the analysis host, the CLI, and the static demo all run the same code. The CLI and the app share the `engine` package, so behavior is identical headless and in the UI.

```ts
interface EpochApi {
  openProject(path: string): Promise<ProjectInfo>;
  getGraph(): Promise<Graph>;
  onProgress(cb: (p: Progress) => void): Unsubscribe;
  onGraphDelta(cb: (d: GraphDelta) => void): Unsubscribe;     // watcher-driven incremental updates
  getBlastRadius(nodeId: string, opts: BlastRadiusOptions): Promise<BlastRadiusResult>;
  getFindings(filter?: FindingFilter): Promise<Finding[]>;     // excludes dismissed unless asked
  dismissFinding(id: string, note?: string): Promise<void>;
  undismissFinding(id: string): Promise<void>;
  getCodePreview(file: string, startLine: number, endLine: number): Promise<CodePreview>; // read-only, inside project root
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;    // any field of any section; raising spend limits is confirmed natively (ADR-016)
  setKey(provider: string, value: string): Promise<void>;      // one-way: value is never readable back
  removeKey(provider: string): Promise<void>;
  getKeyStatus(provider: string): Promise<{ configured: boolean; storage?: "encrypted" | "session" | "weak" }>;
  getSummary(subject: string, opts?: { auto?: boolean }): Promise<SummaryState>;   // file, pkg: or dir:<path>; spends only under the auto rules (ADR-016)
  generateSummary(planId: string): Promise<SummaryState>;      // spends exactly an approved, single-use plan
  cancelSummaries(): Promise<void>;
  onSummaryProgress(cb: (p: SummaryProgress) => void): Unsubscribe;
  getSpend(): Promise<SpendStatus>;
}
```

`SummaryState` is `ready` (text, an optional stale marker, how it was made), `needs-approval` (a single-use plan id with what would be sent and its worst-case cost), `unavailable` or `failed` (fixed reason codes, never provider text), each with the last summary when there is one. The types are in `core` (`interfaces/api.ts`); the static demo serves precomputed summaries read-only.

Pipeline (each stage is a pure function of its inputs unless noted):

```
Discover → Parse → Extract (cached) → Resolve → Graph → Enrich (hints) → Score → Findings → Store → Serve (IPC) → UI
```

1. **Discover**: walk repo; detect languages and project roots (tsconfig.json, pyproject.toml, go.mod, etc.); respect `.gitignore`, `.epochignore`, and `epoch.config.json` ignores.
2. **Parse**: tree-sitter parses each file (`web-tree-sitter` WASM grammars), in parallel across CPU cores.
3. **Extract**: the language adapter turns the syntax tree into `FileFacts` (imports, exports, flag usages, constant conditions). **This is the cached unit.**
4. **Resolve**: the adapter turns each `RawImport` into a `Resolution`. Recomputed on every run over cached `FileFacts`.
5. **Graph**: assemble nodes and edges (including barrel tracing), fan-in/out, cycles (graphology).
6. **Enrich**: hint edges from git co-change, shared strings, and local embeddings (M6; a no-op before that).
7. **Score**: `RelationScorer` assigns probabilities to candidate hint edges; risk tiers computed here.
8. **Findings**: dead-feature detectors run last so they can use roots, edges, hints, and git history.
9. **Store / Serve**: derived results to the cache; the analysis host streams results to main, which forwards them to the renderer.

Heavy work never runs in the main process or the renderer. Long analyses stream progress so the UI stays responsive.

## Data contracts

These are the zod schemas in `core`. Types below are the shape; PLAN.md says when each is built.

```ts
// Node id: repo-relative path with forward slashes (files) or "pkg:<import path>" (Go packages).
// Edge direction: `source` depends on `target` (source imports target).

type ImportedName = { imported: string; exportedAs?: string }; // imported: "*" = namespace/all, "default" = default export

type RawImport = {
  kind: "static" | "dynamic" | "require" | "reexport" | "side-effect";
  specifier: string | null;        // null when not a string literal
  dynamicPrefix?: string;          // literal prefix of a template/concat specifier, e.g. "./pages/"
  typeOnly: boolean;
  names: ImportedName[];
  line: number;
};

type ExportInfo = { name: string; from?: { specifier: string; imported: string } }; // `from` set for re-exports

type FlagUsage = {
  flagName: string | null;         // null when the key is not a string literal (cannot be assessed)
  line: number;
  endLine: number;
  detection: "sdk-call" | "wrapper-call" | "env-read";
  strength: "strong" | "weak";     // sdk-call is strong only if the file imports a package named in the pattern's importHints; wrapper-call and env-read are user-declared, so strong
  provider?: string;
  patternId?: string;
};

type ConstantCondition = {
  name: string | null;             // identifier of the constant; null for literal conditions such as `if (false)`
  value: boolean;
  scope: "literal" | "local" | "module" | "exported";
  line: number;                    // the condition site
  endLine: number;
  deadBranch: "then" | "else";     // the branch that can never run
};

type FileFacts = {                 // cached unit: pure function of file content + adapter + extractor config
  imports: RawImport[];
  exports: ExportInfo[];
  exportAllFrom: string[];         // specifiers of `export * from`
  flagUsages: FlagUsage[];
  constantConditions: ConstantCondition[];
  strings: string[];               // key-like literals (event names, routes, topics, config keys), at most 64; shared-string hints (ADR-014)
  isGenerated: boolean;            // generated-file marker found
  loc: number;
};

type UnresolvedReason = "dynamic-specifier" | "not-found" | "unsupported-syntax" | "outside-project" | "ambiguous";

type Resolution =
  | { kind: "file"; target: string }
  | { kind: "package"; target: string }        // e.g. a Go package node
  | { kind: "external"; name: string }         // third-party: recorded on the node, never materialized as a node
  | { kind: "unresolved"; reason: UnresolvedReason; pathPrefix?: string };

type UnresolvedImport = { from: string; specifier: string | null; reason: UnresolvedReason; pathPrefix?: string; line: number };

type EntryPoint = { file: string; reason: "manifest" | "script" | "config" | "convention" | "test"; source: string };

type GraphNode = {
  id: string;
  kind: "file" | "package";
  language: string;
  loc: number;
  contentHash: string;             // for package nodes: hash of the sorted member file hashes
  exports: string[];
  externals: string[];             // third-party packages this node imports
  flags: FlagUsage[];
  role?: { label: string; confidence: number };   // from scorer, e.g. controller/model/util/test/config
  metrics: {                       // optional fields are absent until computed (ADR-011)
    fanIn: number; fanOut: number;
    dependents?: number;           // transitive, over the "Blast radius, certain" edge set
    churn90d?: number; coverage?: number;
    risk?: { tier: RiskTier; archetype: RiskArchetype };  // absent without git history (ADR-015)
  };
};

type RiskTier = "critical" | "high" | "moderate" | "low-moderate" | "low";   // most to least risky
type RiskArchetype = "volatile-core" | "active-hotspot" | "warm-core" | "fragile-leaf" | "frozen-core" | "stable-leaf";

type GraphEdge = {
  source: string;
  target: string;
  kind: "import" | "dynamic-import" | "reexport" | "type-only" | "via-barrel" | "cochange" | "shared-string" | "semantic";
  provenance: "resolver" | "syntactic" | "git-cochange" | "shared-string" | "embedding" | "trace" | "model";
  confidence: number;              // 1.0 for resolver-proven facts; <1 for hints
  evidence: string[];              // e.g. ["via barrel components/index.ts"], ["changed together in 42 of 51 commits"]
};

type FindingKind = "dead-branch" | "stale-flag" | "unreachable-file";
type Confidence = "high" | "medium" | "low";

type Finding = {
  id: string;                      // stable: hash of kind + subject + discriminator; NEVER includes line numbers, so dismissals survive edits
  kind: FindingKind;
  subject: { type: "flag" | "file"; name: string };   // flag key, or repo-relative path
  confidence: Confidence;
  locations: { file: string; line?: number; endLine?: number }[];
  evidence: string[];              // facts that support the finding
  caveats: string[];               // reasons it might be a false positive
  suggestedAction: string;         // e.g. "Remove the branch that can never run"
  caps: string[];                  // names of the rubric caps that applied (for tests and transparency)
};

type Graph = {
  schemaVersion: number;
  nodes: GraphNode[];              // sorted by id
  edges: GraphEdge[];              // sorted by (source, target, kind)
  roots: EntryPoint[];             // sorted by file
  findings: Finding[];             // sorted by (kind, subject.name, id)
  unresolved: UnresolvedImport[];  // sorted by (from, line)
};

type FlagPattern = {
  id: string;                      // e.g. "openfeature.get-boolean-value"
  provider: string;
  language: string;
  callee: string;                  // function or method name
  keyArgIndex: number;             // which argument holds the flag key
  importHints: string[];           // package/module names; if the file imports one, a match is "strong"
  source: string;                  // REQUIRED: URL of the official docs the entry was authored from
};

type ExtractorConfig = {
  flagPatterns: FlagPattern[];
  wrapperFunctions: string[];      // from epoch.config.json
  envPrefixes: string[];           // from epoch.config.json; plain prefix match, never regex
};

interface GitHistoryProvider {
  status(): { usable: boolean; reason?: "not-a-repo" | "shallow" | "too-short" };  // too-short: history shorter than staleAfterDays
  firstIntroduced(flagName: string, files: string[]): Promise<Date | null>;
  lastTouched(file: string, startLine: number, endLine: number): Promise<Date | null>; // uncommitted lines count as "now"
  lastTouchedFile(file: string): Promise<Date | null>;
}
```

**Canonical form.** The `Graph` serialized for tests, benchmarks, and the equivalence test has sorted arrays, forward-slash ids, no timestamps, and no absolute paths. Run metadata (timings, versions, host info) lives outside the `Graph` in a separate `AnalysisMeta`.

### Edge traversal policy

| Analysis | Edge kinds followed |
|---|---|
| Blast radius, certain | `import`, `dynamic-import` (resolved), `reexport`, `type-only` (toggle, default on) |
| Blast radius, likely | the certain set plus hint edges at or above a threshold |
| Fan-in / fan-out (node metrics) | the certain set; direct edges only; count distinct neighbor nodes |
| Exposure (risk tiers) | the certain set (`type-only` included); transitive; count distinct dependents |
| Reachability (findings) | ALL fact edge kinds, including `type-only` and `via-barrel` |
| Default display | all fact kinds except `via-barrel` (toggle to show) |

Blast radius is reverse reachability: the nodes that transitively depend on the selected node.

### Barrel transparency rule

When file A imports specifier `X` through a barrel B (`B` re-exports `X` from `C`), the graph gets:
- an edge A → C, kind `import`, evidence `via barrel B` (the real dependency);
- an edge B → C, kind `reexport`;
- an edge A → B, kind `via-barrel` (records the physical import path; excluded from blast radius and fan-in, included in reachability so internal barrels are not reported as unreachable).

Namespace imports (`import * as ns from B`), side-effect imports, and any re-export chain that cannot be traced conservatively produce a normal `import` edge A → B. Consequence: changing a sibling file that B also re-exports does not flag A.

## Language adapter interface

```ts
interface LanguageAdapter {
  id: string;                         // "typescript", "python", "go", ...
  tier: "A" | "B";
  extensions: string[];
  version: string;                    // bump to invalidate cached FileFacts
  detectProjectRoots(repo: RepoView): ProjectRoot[];
  extract(file: ParsedFile, cfg: ExtractorConfig): FileFacts;
  resolveImport(imp: RawImport, from: string, ctx: ResolveContext): Resolution;
  detectEntryPoints(ctx: ProjectContext): EntryPoint[];   // returns [] until M5
  isTestFile(path: string): boolean;
}
```

Rules:
- Adapters are pure: input in, facts or resolutions out. No network, no model calls, no filesystem writes, no executing project code or config. Read tsconfig, `package.json`, `pyproject.toml`, `go.mod` and similar as data only; never `require` a project's config file.
- `unresolved` is a valid result and must carry a reason. Never silently drop an import.
- Every adapter must pass the shared **conformance suite** (relative import, alias/absolute import, re-export/barrel, cyclic import, external package, dynamic import, type-only import where applicable).

### Known hard problems per language

| Language | Things that make resolution hard |
|---|---|
| TS/JS | tsconfig `paths`, `package.json` `exports`, barrel files, monorepo workspaces, dynamic `import()`, `require(variable)`, type-only imports |
| Python | relative imports, `__init__.py` re-exports, namespace packages, `sys.path` manipulation, dynamic `importlib` |
| Go | `go.mod` module path, `internal/` packages, build tags, imports are package-level not file-level |
| Java/Kotlin | package-to-directory mapping, wildcard imports, classpath, DI frameworks (Spring) hiding real wiring |
| C# | namespaces span files, project references, `using` directives not tied to files |
| Rust | module tree (`mod`, `use`), crate boundaries, re-exports, workspace members |
| Ruby/PHP | autoload conventions (Zeitwerk, PSR-4) rather than explicit imports |
| C/C++ | `#include` paths depend on the build system and preprocessor |

Evaluate precision upgrades (SCIP indexers from Sourcegraph, language-native tooling) in an ADR before building custom resolvers for each Tier A language. Any option that runs project-controlled code (compiler plugins, build scripts) violates principle 8 unless it is sandboxed; the ADR must address this.

## Dead-feature detection (findings)

Alert first. Epoch surfaces candidates with evidence and caveats; it never edits the project (removal assistance is v2).

| Kind | Meaning | Needs git |
|---|---|---|
| `dead-branch` | A branch guarded by a statically constant condition (a literal condition or a never-reassigned boolean constant), so one side can never run | No |
| `stale-flag` | A feature flag (SDK call, user-declared wrapper, or env read with a literal key) introduced long ago and untouched since | Yes |
| `unreachable-file` | A file no entry point can reach through the graph | Optional (raises confidence) |

### Flag detection
- **Pattern packs** are data (validated by zod), per provider and language. Every entry must cite the official docs it was authored from (`source`). Never author patterns from memory. The vendor-neutral OpenFeature API comes first; vendor SDKs are added as needed.
- A call-based match is `strong` only if the file imports a package listed in the pattern's `importHints`; otherwise it is `weak`.
- `wrapperFunctions` and `envPrefixes` from `epoch.config.json` are `strong`. Env-read detection recognizes each language's standard environment-read calls and matches key prefixes literally.
- Non-literal flag keys are recorded with `flagName: null` and surfaced only as an "unassessable usages" count.

### Unreachable files
- **Roots:** manifest entry points mapped to source files, files referenced by package scripts, `entryPoints` from `epoch.config.json`, test files, and convention roots (e.g. `main.ts`, `cli.ts`, `bin/*`, Go `package main`, Python `__main__.py` and `if __name__ == "__main__"`, console-script entry points, `manage.py`/`wsgi.py`/`asgi.py`).
- Reachability follows all fact edges (see traversal policy). A cycle that no root reaches is reported as a group.
- A dynamic import with a literal prefix marks files under that path as "possibly loaded dynamically".
- Framework detection (a data list, e.g. file-system-routing meta-frameworks and Django, extended via ADR) identifies convention-loaded directories.
- Never reported: test files, generated files (e.g. Go's `Code generated ... DO NOT EDIT` header, `@generated` tags), type-declaration files, and paths matched by `ignore` or `findings.ignore`.
- Caveat text always notes: "Not referenced by analyzed code; may be loaded by tooling, reflection, or runtime configuration."

### Confidence rubric (deterministic; implemented in `findings`, tested with fixtures)

**unreachable-file:** start at High, then apply caps; the result is the lowest cap.
- Cap **Low**: covered by a dynamic-import prefix; or inside a convention directory of a detected framework.
- Cap **Medium**: no manifest or config entry point was mapped to source (roots came only from conventions and tests); or the file was touched within `staleAfterDays`; or git history is unusable; or a strong hint edge (M6) links it to a reachable file.

**dead-branch:**
- Literal condition, or a never-reassigned `local` or `module` boolean constant: High.
- `exported` constant: cap Medium (it may be overridden by build-time definitions).
- Names that look like debug or compile-time toggles (e.g. DEBUG, TRACE, VERBOSE, TYPE_CHECKING): cap Low.
- Never reported: reassigned variables, typing-only guards, values derived from the environment or config.

**stale-flag:** only for flags with a literal key, excluding `flags.longLived`, and only when git history is usable.
- Requires BOTH: first introduced at least `staleAfterDays` ago, AND every usage's lines last touched at least `staleAfterDays` ago. Otherwise no finding.
- `strong` usages: Medium. `weak` only: Low. **Never High** (age alone does not prove a flag is dead; long-lived operational flags are legitimate).

### Alerts and review
- After analysis, if any non-dismissed High or Medium findings exist, show a non-modal banner (counts by kind, "Review" button). Never block, never use OS notifications by default. Counts update live as the watcher runs.
- Findings panel: filter by kind and confidence, sort by confidence then removable size, dismiss and undismiss with an optional note. Graph overlay: node badges and a filter. Node panel: evidence, caveats, suggested action, and a read-only code preview (read through the analysis host, inside the project root).
- Dismissals are stored per project in Epoch's own app data, keyed by finding id. Never in the project.
- If git history is unusable, say so in the UI (shallow clone, not a repo, history too short) and skip `stale-flag`.
- If a meta-framework with convention-based loading is detected, show a notice suggesting `entryPoints` configuration.

### `epoch.config.json` (optional, user-written, read-only to Epoch)
JSON at the project root, validated by zod (size-capped, unknown keys produce a warning). Glob patterns use a glob matcher, never regexes from repo files (ReDoS). Epoch never writes this file; the UI may show a snippet for the user to copy.

```json
{
  "entryPoints": ["src/main.ts", "scripts/**"],
  "ignore": ["**/generated/**"],
  "flags": {
    "wrapperFunctions": ["featureEnabled"],
    "envPrefixes": ["FEATURE_", "ENABLE_"],
    "longLived": ["payments-kill-switch"],
    "staleAfterDays": 90
  },
  "findings": { "minConfidence": "medium", "ignore": ["legacy/**"] }
}
```

`ignore` removes paths from analysis entirely. `findings.ignore` only suppresses findings. `staleAfterDays` defaults to 90 (a default to tune with evidence in M5, not a claim). `findings.minConfidence` defaults to `medium` for the banner, panel default, and CLI.

### CI use
`epoch findings <path> [--json] [--min-confidence <level>] [--fail-on <level>] [--include-dismissed]`. Exit codes: 0 success, 1 error, 2 findings at or above `--fail-on`.

## Local cache

Everything is cached locally. The cache is derived data and always safe to delete.

- **Location:** one per-user cache directory resolved in `core` (e.g. via `env-paths`, app name `epoch`) so the app and the CLI share it. Owner-only permissions. Never inside the analyzed repo.
- **What is cached:** `FileFacts` per file, keyed by hash(file contents + adapter id + adapter version + `extractorConfigHash`). `extractorConfigHash` covers the flag patterns, wrapper functions, and env prefixes, so changing them re-extracts. Also cached: embeddings (M6), summaries (M7), and git history lookups (M5, keyed by path and blob hash; approximate by design, see the findings ADR).
- **What is NOT cached:** resolved edges, the graph, and findings. They are recomputed on every run from cached `FileFacts`, because adding or removing a file elsewhere, or editing tsconfig/go.mod/pyproject, can change how an unchanged file's imports resolve. Add resolution caching only if profiling shows it is the bottleneck, with explicit dependency tracking (ADR).
- **No source stored.** The cache never stores file contents or code excerpts. Only short identifiers and literals that are part of the facts (specifiers, export names, flag keys, key-like strings) and derived values (hashes, metrics, scores, summaries). Display snippets are read from disk on demand.
- **Per-repo index.** File manifest and last analyzed commit, so `--since` and the watcher know what changed.
- **Change detection.** File watcher events and `git diff` against the last analyzed commit; content-hash fallback for non-git folders.
- **Early cutoff.** For downstream model-derived outputs (scores, summaries): if a recomputed input equals the previous one, stop propagating.
- **Hierarchical summaries, bottom-up.** File summaries use the file's code plus dependency summaries; directory summaries use child summaries, not raw code.
- **Lazy model work.** Generate a summary the first time a node is opened, then cache it.
- **Housekeeping.** Schema-versioned; size cap with LRU eviction; Settings shows cache size with Clear; CLI `epoch cache stats | clear | prune`.
- **Storage interface.** `core` defines `CacheStore`; SQLite (`better-sqlite3`) implements it in `engine`; an in-memory version is used in tests.
- **Token accounting.** Every model call logs tokens and cost. Report full-run vs incremental-run cost in the README.

## Privacy and data flow

Document this table in `docs/privacy.md` and the README, and keep it accurate. Any new network call must be added here.

| Feature | What leaves the machine | Default |
|---|---|---|
| Parsing, graph, blast radius, risk tiers, git analysis | Nothing | On |
| Dead-feature detection (reachability, constants, git history) | Nothing | On |
| Heuristic scorer, co-change and shared-string hints | Nothing | On |
| Embeddings similarity | Nothing (small local embedding model, chosen in an ADR) | On |
| Local-model scorer/summaries (e.g. Ollama) | Nothing | Opt-in |
| Jev scorer | Code snippets and context sent to TypeSafe AI | Opt-in |
| LLM summaries / LLM scorer | File source and neighbor summaries sent to the model provider | Opt-in |
| Update check | Request to the release host for the latest version. No project data | On; can be disabled |

With no keys configured and update checks disabled, Epoch makes no network requests.

Rules:
- All remote model features are **off by default**. On first use, show exactly what will be sent and require explicit consent.
- **Offline mode** (app setting and `epoch --offline`) hard-blocks all outbound network, including update checks. A local model on this machine that the user chose (loopback only) keeps working. Enforce it in main and the analysis host through a single network wrapper, and at the Electron session level. An automated test runs a full analysis with the network blocked and asserts zero outbound requests.
- Respect `.gitignore` and `.epochignore`. Never send files matching secret patterns (`.env*`, keys, credentials) to any remote model, even if the user opts in.
- No telemetry. No crash reporting that includes paths or code.
- Sharing is explicit: Export writes a static HTML/JSON file locally that the user can share themselves.

### Bring your own keys

Epoch never pays for, proxies, or sees model usage. Users supply their own credentials: an LLM provider key (Anthropic first, behind a provider-agnostic interface) and a Jev key (early access, waitlist-gated). We operate no servers, so there is nothing to bill and nowhere for keys to go except the provider they belong to.

- **Entry:** Settings → Keys in the app (the renderer sends the key once to main over IPC), or `epoch auth set <provider>` / env vars for the CLI. The UI shows only whether a key is configured, never the value.
- **Storage:** behind a `SecretStore` interface. In the app, use Electron `safeStorage` (OS-level encryption). On Linux, check which backend is in use and warn if it falls back to weak storage. In the CLI, use the OS keychain via a maintained library (ADR) or env vars. Never in the cache, the repo, logs, error messages, browser storage, or exports.
- **Isolation:** keys live only in the main process and analysis host. The renderer never receives a key value. Model calls originate from main or the analysis host, never the renderer.
- **Destination:** each key goes only to its own provider, directly from the user's machine.
- **Cost guardrails:** show an estimated token cost before any bulk job and require confirmation above a threshold; support a spend cap (settings, `--max-spend`) and a per-session budget; show running cost in the UI.
- **Missing keys are normal.** Everything except model-backed scoring and summaries works without keys.
- **Hosted demo:** the static demo has no model features. Any summaries shown for demo repos are precomputed once; visitors never trigger paid calls.

### Electron security

The renderer displays data derived from untrusted repos, and the app can read the user's files, so lock it down:
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. Never relax these.
- The preload script exposes a narrow, typed API. Never expose `ipcRenderer` or generic channels. Validate every IPC payload with zod and verify the sender.
- Strict Content-Security-Policy. Load only the bundled local UI, never remote content. No `<webview>`. Deny `window.open` and in-app navigation to external URLs; open external links in the default browser after an allowlist check.
- The renderer can never request arbitrary file paths. The analysis host reads only inside the project folder the user opened, with resolved-path and symlink checks.
- Render repo-derived strings (file names, flag names, summaries, evidence) as text, never as HTML.
- Native dependencies (`better-sqlite3`) must be rebuilt for Electron's ABI. Keep Electron updated.

## RelationScorer (pluggable models for hints)

Models are used for probabilistic judgments, never for fact edges or findings.

```ts
interface RelationScorer {
  scoreRelations(candidates: CandidatePair[]): Promise<ScoredRelation[]>;  // probability + short rationale tag
  classifyFiles(files: FileContext[]): Promise<FileRole[]>;                // enum role + confidence
}
```

Implementations (all behind the same interface):
- **HeuristicScorer**: no AI; co-change ratios and shared-string matches. The baseline everything else must beat, and the default in offline mode.
- **LocalScorer**: a small local model (e.g. Ollama or ONNX), fully offline.
- **JevScorer**: TypeSafe AI's Jev (early access, waitlist). A "System One" model: typed structured output with calibrated probabilities, fast and very cheap per their published pricing. Schema-valid output is guaranteed, which does NOT mean the answer is correct. Verify calibration on our own data. Cannot generate prose. Remote, opt-in only, with the user's own key.
- **LlmScorer**: a small cheap Claude model with structured output, as a fallback and comparison point. Remote, opt-in only, with the user's own key.

Rules:
- **Never score all pairs.** Generate candidates first (git co-change, embedding similarity, shared strings), then score only candidates.
- Scorer outputs become hint edges with `provenance: "model"` and the probability as `confidence`. Show evidence.
- Verify before showing: if a model claims a symbol or call exists, check the parse tree.
- Benchmark scorers against each other and ground truth: precision/recall at thresholds and calibration. Put results in the README.
- Prose summaries use a regular text LLM (or a local model), lazy and cached, grounded in file source plus neighbor summaries. Jev cannot do this.

## Risk tiers (ordinal)

A file's risk is a tier and an archetype from three facts, never a made-up number (ADR-015). Show the facts behind the tier in the UI.

| Dimension | Values (default thresholds) |
|---|---|
| Exposure | **exposed**: more than 5 transitive dependents (traversal policy, "Exposure"); else **contained** |
| Change | **hot**: 3 or more commits in the last 90 days; **warm**: 1 or 2; **quiet**: 0 |
| Fragility | **fragile**: more than 300 lines, or line coverage below 50% when a coverage report covers the file; else **sturdy** |

Rules, first match wins:

| Tier | Archetype | Rule |
|---|---|---|
| Critical | Volatile core | exposed + hot + fragile |
| High | Active hotspot | exposed + hot, or exposed + warm + fragile |
| Moderate | Warm core | exposed + warm |
| Moderate | Fragile leaf | contained + hot, or contained + warm + fragile |
| Low–moderate | Frozen core | exposed + quiet |
| Low | Stable leaf | everything else (contained + warm + sturdy, contained + quiet) |

- No git history: no tier; the UI says why. No coverage report: fragility from size alone.
- Wherever files are ordered by risk: by tier, then dependents, then churn.
- The thresholds are defaults to tune with evidence (`pnpm bench:risk`), like `staleAfterDays`, not claims.
- Coverage formats to support first: lcov and Cobertura XML, then Go cover profiles and JaCoCo.

## Blast radius

- Reverse BFS from the selected node over the edge kinds in the traversal policy. Cycle-safe.
- **Certain mode:** fact edges. **Likely mode:** plus hint edges at or above a user-adjustable threshold.
- Report: total affected nodes, max depth, grouping by directory and by language, and how many results depend on hint edges.
- Implemented as a pure function in `core` so the analysis host, CLI, and static demo share it.

## App UX basics

- Open Project via native folder dialog, drag-and-drop a folder onto the window, and a recent-projects list. One project per window.
- Native menus and keyboard shortcuts; follows the OS light/dark theme; remembers window state.
- First-run screen explains the privacy model in a few sentences and that model features are off until enabled.
- Progress is always visible during analysis, and results appear incrementally.
- Findings alerts: see "Alerts and review".
- Large graphs: collapse by directory, run layout (fcose or ELK) in a Web Worker, and consider Sigma.js (WebGL) only if Cytoscape hits a measured ceiling.

## Distribution

- **Installers:** macOS (dmg), Windows (NSIS), Linux (AppImage/deb), built in a GitHub Actions matrix (one runner per OS) and published on GitHub Releases.
- **Auto-update:** via the release host (e.g. `electron-updater`), opt-out, listed in the data-flow table.
- **Code signing:** macOS notarization needs a paid Apple Developer account and Windows signing needs a certificate. Ship early builds unsigned with documented first-run steps, and decide on signing before a public launch. Be upfront about this in the README.
- **Static site:** landing page, download links, and an in-browser demo viewer with precomputed graphs and findings of well-known public OSS repos (reuses the UI via the static `EpochApi`). No backend, no user code, no model features.
- **CLI:** also published to npm for headless and CI use (`epoch analyze --json`, `epoch findings`). We host nothing.

## Tech stack (defaults, change via ADR)

- **Language**: TypeScript, strict mode. pnpm workspaces + Turborepo.
- **Desktop shell**: Electron, built with `electron-vite`, packaged with `electron-builder`.
- **Shared types**: zod schemas for the graph, findings, config, and IPC, validated at boundaries.
- **Parsing**: `web-tree-sitter` with grammar WASM files per language; TS compiler API module resolution for the TS/JS adapter.
- **Parallelism**: `piscina` worker pool inside the analysis host (`utilityProcess`).
- **Graph algorithms**: `graphology` in memory. No graph database.
- **Git**: `simple-git` plus direct `git` invocations where needed. **Watching**: `chokidar`.
- **Cache**: SQLite via `better-sqlite3`, rebuilt for Electron.
- **Frontend (renderer)**: React + Vite + Cytoscape.js + Tailwind.
- **Integrations**: Jev API (when access is granted), Anthropic, OpenAI or Gemini API for summaries (the user's choice and key; ADR-019), Anthropic API for the fallback scorer, optional Ollama.
- **Testing**: Vitest for unit tests; Playwright (Electron support) for end-to-end.
- **Why Electron, not Tauri (for now):** the engine depends on Node (TS compiler API, native modules, worker threads), which runs as-is in Electron. Tauri would need a Node sidecar or a Rust rewrite of the engine. Electron also ships a consistent Chromium for Cytoscape/WebGL across OSes. Cost: larger installers and memory use. Recorded in an ADR; revisit in v2.

## Repo layout

```
epoch/
  CLAUDE.md
  PLAN.md
  README.md
  package.json
  pnpm-workspace.yaml
  turbo.json
  packages/
    core/             # schemas, interfaces, canonicalization, graph algorithms (blast radius, reachability, SCC), risk tiers. Pure, no I/O
    adapters/
      typescript/
      python/
      go/
      ...             # one package per language
    findings/         # dead-feature detectors, confidence rubric, flag pattern packs (data). Pure
    scorers/          # heuristic, local, jev, llm implementations of RelationScorer
    engine/           # runs the pipeline: SQLite CacheStore, watcher, git (churn, history provider), worker pool, config loader, dismissals store
    cli/              # headless `epoch` bin (benchmarks, CI)
    app/              # Electron: main process, preload, analysis-host entry, packaging config
    ui/               # React + Cytoscape renderer, written against EpochApi
  apps/
    site/             # landing page, downloads, static demo viewer + precomputed public-repo graphs
  queries/            # tree-sitter .scm queries per language (imports, calls, constants)
  fixtures/
    typescript/ python/ go/ ...   # conformance/ and findings/ cases, each with expected output
  docs/
    architecture.md
    privacy.md        # the data-flow table
    findings.md       # finding kinds, rubric, configuration
    decisions/        # ADRs
    benchmarks/       # generated reports
```

## Commands (add to package.json as built)

```
pnpm install
pnpm dev                       # Electron app with hot reload
pnpm package                   # build installers for the current OS
pnpm test                      # vitest across packages
pnpm e2e                       # Playwright against the built app
pnpm lint && pnpm typecheck
epoch analyze <path> [--json] [--since <commit>]   # headless CLI
epoch findings <path> [--json] [--min-confidence <level>] [--fail-on <level>] [--include-dismissed]
epoch cache stats | clear | prune
epoch --offline ...            # hard-block all outbound network
pnpm bench <path>              # parse time, incremental time
pnpm bench:accuracy <repo>     # edge precision/recall vs ground truth
pnpm bench:findings <repo>     # finding comparisons, hindsight test, review sheet
pnpm bench:scorers             # scorer evaluation
pnpm bench:risk                # risk tiers against later fix commits (hindsight)
```

## Testing and accuracy

- Each adapter has fixture repos with expected output (golden files) and must pass the shared conformance suite. Findings have their own fixtures under `fixtures/<lang>/findings/`.
- **Equivalence property test:** for random edit sequences on fixtures, the incremental result equals a from-scratch recompute (canonical `Graph` JSON, including findings once M5 exists).
- For each Tier A language, measure edge precision/recall against a ground-truth tool on at least one real OSS repo.
- Findings: compare against an existing tool where one exists, run a hindsight test, and measure precision on a human-reviewed sample (see PLAN.md M5). Report all limits.
- Scorers: temporal-holdout evaluation with precision/recall and calibration.
- Risk tiers: hindsight evaluation (later fix commits per tier, on a window after the one the thresholds were chosen on).
- Offline test, secrets test, Electron security tests, local-cache tests (hit/miss, no source stored), and e2e (open folder, blast radius, findings banner, incremental update).
- Every graph-correctness or finding-rubric change starts with a fixture and a failing test.

## Conventions

- Strict TypeScript, no `any` without a comment explaining why.
- Pure functions in `core`, `findings`, and adapters; side effects in `engine`, `scorers`, and `app`.
- Small commits, conventional commit messages.
- An ADR in `docs/decisions/` for each real design choice (the register is in PLAN.md).
- No secrets in the repo. `.env` gitignored, `.env.example` committed.

## Definition of done for MVP

- Installers for macOS and Windows (Linux if time) built by CI and published on GitHub Releases. Opening a real project folder works on a fresh machine with no account or setup.
- Static site with a demo viewer showing graphs and findings for real OSS repos in at least three languages (TS/JS, Python, Go).
- README: problem, privacy model and data-flow table, demo GIF, architecture diagram, tradeoffs, signing status, a section on how findings work with their limits, and measured benchmarks (full vs incremental time, token cost, edge precision/recall per language, finding precision, scorer calibration).
- Offline mode and Electron security tests passing.
- Findings verified on fixtures for TS/JS, Python, and Go, with the rubric caps tested.
- CI passing (lint, typecheck, tests, conformance suite, e2e).

## Instructions for Claude when working in this repo

- Read this file first, then PLAN.md. Follow PLAN.md's procedure: plan the next unchecked milestone in plan mode and wait for my approval before writing code.
- Respect the MVP vs v2 boundary. Do not build ahead.
- Never let a model produce a fact edge or a finding. Findings come from the deterministic rubric only.
- Never modify files inside an analyzed project. Never execute code or config from an analyzed project.
- Never present a finding as certain. Keep the wording "candidate", "likely", or "stale".
- Never add code that sends source code or derived data off the machine without explicit opt-in, and document any new network call in the data-flow table. No telemetry. No local HTTP server.
- Never enable `nodeIntegration`, disable `contextIsolation` or `sandbox`, load remote content in the app window, or expose generic IPC to the renderer. All IPC goes through the typed, zod-validated API.
- The renderer never receives keys or arbitrary filesystem access.
- Never store file contents or code excerpts in the cache.
- Keys are always user-supplied. Never hardcode, bundle, log, cache, or export any key, and never route model calls through a server we run.
- Any feature that spends the user's money must show a cost estimate first and respect the spend cap.
- Never claim a language is Tier A unless it passes the conformance suite and has a measured accuracy number.
- Do not guess external API shapes, SDK function names, or prices. Read the current official docs, cite them, and pin versions.
- When adding a language, start from fixtures and the conformance suite, then write the adapter.
- Before adding a dependency, say why and check whether existing tools cover it.
- Prefer small, reviewable changes. Explain non-obvious tradeoffs briefly.
- If a requirement is ambiguous on anything architectural, ask one concise question.
- Do not fabricate metrics or benchmark numbers. Measure them.
