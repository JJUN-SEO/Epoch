# The `epoch` command line

The CLI runs the same engine as the desktop app, without a window: the same parsing, graph, risk tiers and findings, read-only on the project. You don't need it to use Epoch. It is there for:

- **CI checks.** `epoch findings --fail-on <level>` exits with code 2 when candidates at or above that confidence remain. Once a project's existing candidates are resolved or listed under `findings.ignore` in `epoch.config.json`, a pull request that adds a file no entry point reaches, or a branch that likely never runs, fails the check.
- **Scripts and other tools.** `epoch analyze --json` prints the canonical graph (nodes, edges with provenance and confidence, entry points, findings, unresolved imports) for other tools to read.
- **Reproducing the numbers.** The benchmarks in [results.md](results.md) and the demo site's graphs are produced with it, so anyone can rerun them without the app.

## Getting it

The CLI is not published to npm yet. Build it from a clone of this repository (requirements in [development.md](development.md)):

```sh
pnpm install
pnpm build
node packages/cli/dist/bin.js --help
```

The examples below write `epoch` for `node packages/cli/dist/bin.js`.

## Commands

```sh
epoch analyze <path> [--json] [--since <commit>] [--coverage <file>]
epoch findings <path> [--json] [--min-confidence <level>] [--fail-on <level>] [--include-dismissed]
epoch cache stats | clear | prune [--max-size <MB>]
epoch auth set | status | remove <provider>
```

- `analyze` builds the dependency graph of a project folder. `--json` prints it on stdout; `--since <commit>` also re-reads files changed between that commit and HEAD; `--coverage` points at a coverage report: lcov, Cobertura XML, Istanbul JSON, Clover XML or a Go profile. By default Epoch looks for each test tool's usual report in the project folder and in each package folder ([ADR-020](decisions/ADR-020-coverage-reports.md)).
- `findings` lists likely dead-feature candidates for review: branches that likely never run, possibly stale flags and possibly unused files, each with evidence and caveats. Levels are `high`, `medium` or `low`; the default minimum comes from `findings.minConfidence` in `epoch.config.json`, else `medium`. Findings dismissed in the app stay hidden unless you pass `--include-dismissed`.
- `cache` shows, clears or prunes Epoch's local cache. It holds only derived data, so clearing it just means the next run parses everything again.
- `auth` stores or removes your own model provider key in the OS keychain. The key is read from standard input, never from the command line, and `auth status` never prints it.

Put `--offline` before any command to turn the network off for that run; a model on this machine still works.

Exit codes: `0` success, `1` error, `2` findings at or above `--fail-on`.

## In CI

```sh
epoch findings . --min-confidence medium --fail-on high
```

Dismissals made in the app live on your machine, not in the repository, so a CI run doesn't see them; use `findings.ignore` for anything the check should skip. Clone with full history (for example `fetch-depth: 0` in `actions/checkout`). With a shallow clone Epoch skips stale-flag findings, and churn, and so the risk tiers, counts only the commits the clone has. Until the CLI is on npm, the job has to check out and build Epoch first.

## Hints and models (optional)

Hint edges (files that change together, shared strings, similar code) are computed on this machine by default; `--no-hints` skips them. `--scorer` picks what scores them: `heuristic` (the default, no model), `local` (an Ollama server on this machine), or `llm` and `jev`, which send file excerpts to Anthropic or TypeSafe AI with your own key and need `--consent-send` and a spend cap (`--max-spend`). [privacy.md](privacy.md) lists exactly what each one sends.

## Where things live

The cache lives in the per-user cache directory (`EPOCH_CACHE_DIR` moves it); dismissals live in the per-user data directory (`EPOCH_DATA_DIR`). An optional `epoch.config.json` at the project root sets entry points, ignores and flag settings; [findings.md](findings.md) describes it.

Every option, with its default: `epoch --help`.
