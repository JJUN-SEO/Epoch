# Epoch

> **Work in progress** (milestone M7 of [PLAN.md](PLAN.md)). The desktop app opens a project folder and shows its dependency graph for TypeScript/JavaScript, Python and Go (all tier A, precise resolution, with measured accuracy), keeps it up to date as files change, shows the blast radius of any file, rates each file's risk in tiers that say why, and points out likely-dead features as candidates for review. Opt-in summaries of files and folders come from a model on your machine or from Anthropic with your own key, within limits you set.

Epoch is a local-first desktop app (macOS, Windows, Linux) that turns a codebase into an interactive dependency graph. It rates each file's risk in tiers (how exposed, how active, how fragile), shows the blast radius of changing any file, and flags likely-dead features (constant branches, stale feature flags, unreachable files) as candidates for review.

## Privacy

Your code never leaves your machine by default, and Epoch never modifies your project.

- **Local-first.** Source code, the graph and the cache stay on your machine. No accounts, no hosted backend, no telemetry.
- **Read-only on projects.** Epoch writes only to its own cache and settings, and to files you explicitly export.
- **Parse, never execute.** Analyzing a repository never runs its code, scripts or config.
- **Model features are opt-in.** Anything that would send data to a model provider is off until you enable it with your own key, and the first send in each project asks first.
- **Offline mode** blocks every network request, except to a local model on your machine if you chose one.

What leaves the machine, feature by feature (kept current in [docs/privacy.md](docs/privacy.md)):

| Feature                                                       | What leaves the machine                                                         | Default             | Status today                                                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsing, graph, blast radius, risk tiers, git analysis        | Nothing                                                                         | On                  | Built                                                                                                                                                                                     |
| Dead-feature detection (reachability, constants, git history) | Nothing                                                                         | On                  | Built                                                                                                                                                                                     |
| Heuristic scorer, co-change and shared-string hints           | Nothing                                                                         | On                  | Built                                                                                                                                                                                     |
| Embeddings similarity                                         | Nothing (a small local embedding model, all-MiniLM-L6-v2, bundled with the app) | On                  | Built (model chosen on measurements in ADR-008); the app adds similarity after the first graph when its installer carries the model                                                       |
| Local-model scorer and summaries (e.g. Ollama)                | Nothing                                                                         | Opt-in              | Built: the app's summaries (still work in offline mode) and the CLI scorer (`--scorer local`)                                                                                             |
| Jev scorer                                                    | Code snippets and context sent to TypeSafe AI                                   | Opt-in              | Built: the CLI scorer (`--scorer jev`, your key, `--consent-send`, `--max-spend`; ADR-017); not in the app                                                                                |
| LLM summaries and LLM scorer                                  | File source and neighbor summaries sent to the model provider                   | Opt-in              | Built: the app's summaries (just your key, then consent once per project; capped at $5 a month unless you change it) and the CLI scorer (`--scorer llm`, `--consent-send`, `--max-spend`) |
| Update check                                                  | A request to the release host for the latest version. No project data           | On; can be disabled | Not built yet; offline mode forces it off                                                                                                                                                 |

With no keys configured and update checks disabled, Epoch makes no network requests.

The full rules are in [CLAUDE.md](CLAUDE.md).

## Measured so far

Every number is measured on pinned public repositories; the reports say how.

| What                                                                                                                       | Result                                                                                                                                                                                                                                                                                                                                                                                                     | Report                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| TS/JS edge accuracy vs dependency-cruiser (zod, vitest)                                                                    | every disagreement classified                                                                                                                                                                                                                                                                                                                                                                              | [typescript.md](docs/benchmarks/typescript.md)                                              |
| Python edge accuracy vs grimp 3.17 (Flask 3.1.3)                                                                           | 100% recall; precision 71.6% raw, 100% counting the imports grimp cannot see (namespace subpackages)                                                                                                                                                                                                                                                                                                       | [python-accuracy.md](docs/benchmarks/python-accuracy.md)                                    |
| Go edge accuracy vs `go list` (cli/cli v2.82.0)                                                                            | 100% precision and recall (production); tests 99.5% / 100%, the gap is build-tagged files                                                                                                                                                                                                                                                                                                                  | [go.md](docs/benchmarks/go.md)                                                              |
| Watcher: file write to updated graph                                                                                       | 0.34 s (Flask, 83 files), 1.27 s (vitest, 2,451 files), medians of 3                                                                                                                                                                                                                                                                                                                                       | [watcher.md](docs/benchmarks/watcher.md)                                                    |
| 90-day churn query on a full history                                                                                       | 0.04 s (cli/cli, 399 commits in the window)                                                                                                                                                                                                                                                                                                                                                                | [watcher.md](docs/benchmarks/watcher.md)                                                    |
| Analysis time, full vs incremental                                                                                         | see the report                                                                                                                                                                                                                                                                                                                                                                                             | [typescript-performance.md](docs/benchmarks/typescript-performance.md)                      |
| Possibly unused files vs knip 6.38.0 (zod)                                                                                 | 128 files both report (all 10 of Epoch's High among them), 27 only Epoch (none High), 6 only knip; every disagreement categorized                                                                                                                                                                                                                                                                          | [findings.md](docs/benchmarks/findings.md)                                                  |
| Findings stage, cold / warm cache                                                                                          | 0.06–4.11 s / 0.07–1.27 s on five repositories (git history lookups included)                                                                                                                                                                                                                                                                                                                              | [findings.md](docs/benchmarks/findings.md)                                                  |
| Finding precision on a reviewed sample (reviewed by Claude at the maintainer's request, not by a human)                    | Worth a look: 11 of 11 (every High finding on five repositories; 25% before the rubric was tuned); Maybe: 8 of 39 (20.5%)                                                                                                                                                                                                                                                                                  | [findings.md](docs/benchmarks/findings.md), [ADR-007](docs/decisions/ADR-007-findings.md)   |
| Hint calibration, temporal holdout (zod, vitest, Flask, cli/cli)                                                           | Without a model (3,145 judged candidates): Brier 0.188 (constant baseline 0.240), ECE 0.059, ROC AUC 0.724; at the 0.5 threshold, precision 68.2% and recall 48.8%. With the local model (15,472): Brier 0.126 (constant 0.148), ECE 0.027, AUC 0.707, and on the pairs proposed without it AUC 0.724 → 0.763. Shared strings added nothing; cli/cli ranks worse than chance without the model (AUC 0.441) | [scorers.md](docs/benchmarks/scorers.md), [ADR-008](docs/decisions/ADR-008-hint-scoring.md) |
| Jev scorer (`jev-1.13.0`), same temporal holdout                                                                           | On the 1,508 judged pairs among the heuristic's top 1,000 per repository (50.1% positive): ROC AUC 0.800 vs the fitted heuristic's 0.826, Brier 0.196 vs 0.171, ECE 0.121 vs 0.059; better than the heuristic only on cli/cli (AUC 0.865 vs 0.659). 4,000 requests, 13.5M input tokens, 126 ms each on average, $0.5674 at the documented price                                                            | [scorers.md](docs/benchmarks/scorers.md), [ADR-017](docs/decisions/ADR-017-jev-scorer.md)   |
| Local embedding model (all-MiniLM-L6-v2 vs bge-small-en-v1.5 and jina-embeddings-v2-small-en)                              | 21.6 ms per file on the CPU, 3.3–4.4× faster than the other two at about the same quality (ROC AUC within 0.02); a 90.4 MB file                                                                                                                                                                                                                                                                            | [ADR-008](docs/decisions/ADR-008-hint-scoring.md) item 7                                    |
| Risk tiers in hindsight (zod, vitest, Flask, cli/cli; files fixed in the next 180 days, a window the thresholds never saw) | critical 81.4%, high 50.0%, moderate 33.1%, low-moderate 11.9%, low 9.5%; the top two tiers match the removed weighted score at the same cut (better on zod)                                                                                                                                                                                                                                               | [risk.md](docs/benchmarks/risk.md), [ADR-015](docs/decisions/ADR-015-risk-tiers.md)         |
| Summary cost, full vs incremental (Flask, one commit changing 7 source files)                                              | **Not measured with a model yet** (no key was available). Epoch's own upper estimate: a full run is 108 requests, at most $0.102 at Claude Haiku 5.5 prices; after the commit, the app sends 7 requests for the changed files as they are opened, at most $0.011                                                                                                                                           | [summaries.md](docs/benchmarks/summaries.md)                                                |

## How findings work

Epoch flags three kinds of likely-dead code: **branches that likely never run** (a constant condition), **possibly stale flags** (OpenFeature calls, your own wrapper functions or prefixed environment variables, introduced long ago and untouched since) and **possibly unused files** (no entry point reaches them). Each finding is a candidate, never a verdict: it lists what static analysis cannot see first, then its evidence, a confidence level from a fixed rubric ("Worth a look", "Maybe", "Unsure") with the reason for any cap, and a suggested next step. Nothing is ever changed in your project; dismissals are kept in Epoch's own data folder.

The main limit: files loaded by tooling (build configs that compute paths, bundle inputs passed on a command line, plugin systems) or by languages Epoch does not analyze can look unused. "Worth a look" is kept for files in packages that declare their entry points, where an unreached file is most likely really unused; elsewhere the best rating is "Maybe". List them under `entryPoints` in `epoch.config.json`. Details, the full rubric and configuration: [docs/findings.md](docs/findings.md).

## Development

Requirements:

- **Node.js 24.21.0** (the Node bundled in Electron 43.7.7, which the app uses). With [fnm](https://github.com/Schniz/fnm), `fnm use` picks it up from `.node-version`. With nvm-windows, run `nvm install 24.21.0`, then `nvm use 24.21.0`. `pnpm install` fails on unsupported Node versions on purpose.
- **pnpm 11.28.2**: run `npm i -g pnpm@11.28.2`. Inside this repository, `pnpm -v` must print `11.28.2`.

Then:

```sh
pnpm install
pnpm check
```

`pnpm check` runs lint, typecheck and the tests, and works in any shell, including Windows PowerShell 5.1.

### Running the app

Electron 43 has no install script; its binary comes from a separate step, run once:

```sh
pnpm --filter @epoch-dev/app exec install-electron
pnpm dev       # the app with hot reload
pnpm package   # an unpacked, unsigned app in packages/app/release/ (installers come in M8)
pnpm e2e       # Playwright end-to-end and security tests against the built app
```

`pnpm e2e` runs against `pnpm build` output; set `EPOCH_E2E_TARGET=packaged` to test the `pnpm package` output instead. On Linux, run it under `xvfb-run` as a non-root user: the tests keep Chromium's sandbox on, which refuses root. Ubuntu 24.04 also needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` for that sandbox, as CI does.

The headless CLI shares the engine: `node packages/cli/dist/bin.js analyze <folder> [--json] [--coverage <report>]` after `pnpm build`.

Similarity hints need the local embedding model, which is not in the repository. `node scripts/fetch-model.mjs` downloads the pinned default into `models/` (checked against its sha256; behind a proxy, set `NODE_USE_ENV_PROXY=1`). `pnpm dev` and `pnpm package` then use it, and the CLI takes `--embedding-model models/<id>`. Without it, everything else works and similarity is off.

| Command                      | What it does                                                        |
| ---------------------------- | ------------------------------------------------------------------- |
| `pnpm build`                 | Compile every package (`dist/`, and the app's `out/`)               |
| `pnpm dev`                   | Run the desktop app with hot reload                                 |
| `pnpm package`               | Build an unpacked, unsigned app for this OS                         |
| `pnpm e2e`                   | Playwright end-to-end and security tests                            |
| `pnpm bench`                 | Analysis timings on pinned repositories                             |
| `pnpm bench:accuracy`        | TS/JS edge accuracy against dependency-cruiser                      |
| `pnpm bench:accuracy-python` | Python edge accuracy against grimp (needs a virtualenv)             |
| `pnpm bench:accuracy-go`     | Go edge accuracy against `go list` (needs a Go toolchain)           |
| `pnpm bench:watch`           | Watcher latency and churn cost                                      |
| `pnpm bench:scorers`         | Hint scorers on a temporal holdout (`--embedding-model <dir>`)      |
| `pnpm typecheck`             | Type-check every package                                            |
| `pnpm lint`                  | Prettier check, then ESLint on every package                        |
| `pnpm test`                  | Build, then run each package's Vitest suite                         |
| `pnpm check`                 | `lint`, `typecheck` and `test` in one command                       |
| `pnpm format`                | Format the repository with Prettier                                 |
| `pnpm telemetry:off`         | Turn off Turborepo telemetry for direct `turbo` use on this machine |

The root scripts already run Turborepo with its telemetry turned off. `pnpm telemetry:off` is only needed if you also run `turbo` directly.

### Windows notes

- If `prettier --check` reports line-ending problems in a file you just created, run `pnpm format`. The repository stores LF everywhere (`.gitattributes`).
- Rename files only with `git mv`. For a change of case only, go through a temporary name: `git mv a.ts tmp.ts`, then `git mv tmp.ts A.ts`.

## Repository layout

```
packages/
  core/                 schemas, interfaces, pure graph algorithms
  adapters/typescript/  TypeScript/JavaScript language adapter (tier A)
  adapters/python/      Python language adapter (tier A)
  adapters/go/          Go language adapter, packages as nodes (tier A)
  findings/             dead-feature detectors and confidence rubric (from M5)
  engine/               analysis pipeline, cache, parse worker pool, git churn, coverage, watcher
  cli/                  the headless `epoch` command
  app/                  Electron main process, preload, analysis host, packaging
  ui/                   React + Cytoscape renderer, written against EpochApi
  bench/                pnpm bench and the accuracy and watcher benchmarks
queries/                tree-sitter queries per language
fixtures/               conformance and safety fixtures per language
docs/decisions/         architecture decision records
docs/benchmarks/        generated and measured reports
```

## Documentation

- [CLAUDE.md](CLAUDE.md): what Epoch is, the rules, and the data contracts (source of truth).
- [PLAN.md](PLAN.md): build order, milestones and acceptance criteria.
- [docs/findings.md](docs/findings.md): finding kinds, rubric, configuration and limits.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

[MIT](LICENSE) © 2026 Junhyuk Seo
