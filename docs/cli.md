# The `epoch` command line

The CLI runs the same engine as the desktop app, without a window: the same parsing, graph, risk tiers and findings, read-only on the project. You don't need it to use Epoch. It is there for:

- **CI checks.**
  - `epoch findings --fail-on <level>` exits with code 2 when candidates at or above that confidence remain. Once a project's existing candidates are resolved or listed under `findings.ignore` in `epoch.config.json`, a pull request that adds a file no entry point reaches, or a branch that likely never runs, fails the check.
  - `epoch impact --base <ref>` says what a pull request touches: each changed file's risk tier and candidates, and every file that depends on them. `--fail-on <tier>` exits with code 2 when a changed file is at or above that risk tier.
- **Questions about one file.** `epoch explain` gives a file's facts, and `epoch path` shows how one file depends on another.
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
epoch impact <path> (--base <ref> | --files <file>...) [--json | --markdown] [--likely] [--fail-on <tier>]
epoch path <path> <from> <to> [--json] [--likely]
epoch explain <path> <file> [--json]
epoch export <path> --format graphml|mermaid|dot [--scope <folder>] [--likely] [--out <file>]
epoch cache stats | clear | prune [--max-size <MB>]
epoch auth set | status | remove <provider>
```

- `analyze` builds the dependency graph of a project folder. `--json` prints it on stdout; `--since <commit>` also re-reads files changed between that commit and HEAD; `--coverage` points at a coverage report: lcov, Cobertura XML, Istanbul JSON, Clover XML or a Go profile. By default Epoch looks for each test tool's usual report in the project folder and in each package folder ([ADR-020](decisions/ADR-020-coverage-reports.md)).
- `findings` lists likely dead-feature candidates for review: branches that likely never run, possibly stale flags and possibly unused files, each with evidence and caveats. Levels are `high`, `medium` or `low`; the default minimum comes from `findings.minConfidence` in `epoch.config.json`, else `medium`. Findings dismissed in the app stay hidden unless you pass `--include-dismissed`.
- `impact` reports what a change touches ([ADR-021](decisions/ADR-021-agent-access-and-change-impact.md)).
  - `--base <ref>` takes the files changed between that commit and HEAD. `--files` names them, relative to `<path>`, for "what would changing these affect?".
  - It lists each changed file with its risk tier, how many files depend on it and the candidates located in it, then the files that depend on the change, grouped by folder. Changed files that are not in the graph (documentation, deleted files) are listed as not analyzed.
  - `--markdown` prints the same report as Markdown. `--fail-on` takes a risk tier: `critical`, `high`, `moderate`, `low-moderate` or `low`.
- `path` prints the shortest chain of imports from `<from>` to `<to>`. If `<from>` doesn't depend on `<to>`, it says so, and shows the chain the other way round when there is one.
- `explain` prints one file's facts: language and support tier, risk tier with the side of each threshold it fell on, dependents, commits in the last 90 days, coverage, what it imports and what imports it, likely relations, unresolved imports and candidates.
- `export` writes the graph as GraphML, a Mermaid flowchart or Graphviz DOT, to stdout or to the file given with `--out`. `--scope <folder>` keeps one folder's files.
- For `path` and `explain`, a file can be named by its path in the project or by any ending that fits one file (`schemas.ts`). A name that fits several is refused, with the candidates listed.
- `--likely` (impact, path, export) also follows likely relations, the hint edges, and marks what depends on them. Without it only proven imports count.
- `cache` shows, clears or prunes Epoch's local cache. It holds only derived data, so clearing it just means the next run parses everything again.
- `auth` stores or removes your own model provider key in the OS keychain. The key is read from standard input, never from the command line, and `auth status` never prints it.

Put `--offline` before any command to turn the network off for that run; a model on this machine still works.

Exit codes: `0` success, `1` error, `2` findings at or above `--fail-on` (for `impact`: a changed file at or above the risk tier).

## In CI

```sh
epoch findings . --min-confidence medium --fail-on high
epoch impact . --base origin/main --markdown >> "$GITHUB_STEP_SUMMARY"
epoch impact . --base origin/main --fail-on critical
```

The second line puts the change-impact report on the job's summary page in GitHub Actions. `--base` compares two commits, so the job needs both: fetch the base branch as well as the pull request's head.

Dismissals made in the app live on your machine, not in the repository, so a CI run doesn't see them; use `findings.ignore` for anything the check should skip. Clone with full history (for example `fetch-depth: 0` in `actions/checkout`). With a shallow clone Epoch skips stale-flag findings, and churn, and so the risk tiers, counts only the commits the clone has. Until the CLI is on npm, the job has to check out and build Epoch first.

## Hints and models (optional)

Hint edges (files that change together, shared strings, similar code) are computed on this machine by default; `--no-hints` skips them. `--scorer` picks what scores them: `heuristic` (the default, no model), `local` (an Ollama server on this machine), or `llm` and `jev`, which send file excerpts to Anthropic or TypeSafe AI with your own key and need `--consent-send` and a spend cap (`--max-spend`). [privacy.md](privacy.md) lists exactly what each one sends.

## Where things live

The cache lives in the per-user cache directory (`EPOCH_CACHE_DIR` moves it); dismissals live in the per-user data directory (`EPOCH_DATA_DIR`). An optional `epoch.config.json` at the project root sets entry points, ignores and flag settings; [findings.md](findings.md) describes it.

Every option, with its default: `epoch --help`.
