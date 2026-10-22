# Findings: likely-dead features, as candidates for review

Epoch points at code that **may** no longer be used. It never says code is dead, never removes anything, and never writes into your project. Every finding is a suggestion to look, with the evidence behind it, the reasons it might be wrong, and a confidence level from a fixed rubric. The decisions behind this page are in [ADR-007](decisions/ADR-007-findings.md); the measurements are in [benchmarks/findings.md](benchmarks/findings.md).

## The three kinds

| Kind (id)          | Shown as                      | What it means                                                                                        | Needs git history |
| ------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------- |
| `dead-branch`      | Branch that likely never runs | An `if`, `elif`/`else if` or conditional expression whose test is a constant, so one side cannot run | No                |
| `stale-flag`       | Possibly stale flag           | A feature flag introduced long ago whose every usage has stayed untouched since                      | Yes               |
| `unreachable-file` | Possibly unused file          | A file that no entry point reaches through imports                                                   | No (it helps)     |

Confidence levels are shown as **Worth a look** (High), **Maybe** (Medium) and **Unsure** (Low).

## How each kind is found

### Branches that likely never run

The adapters (TS/JS, Python, Go) record a condition when its test is:

- a boolean literal or its negation (`if (false)`, `if not True:`, `if !false`);
- or a name bound once, in the same file, to a boolean literal and never written again: a TS `const` (or a `let` with no assignment), a Python name assigned once (not rebound by `global`/`nonlocal`, not a class attribute), a Go `const`.

Skipped on purpose: reassigned or shadowed names, `var` in JS, values computed from anything (environment, config, calls), `TYPE_CHECKING` and `__debug__`, and Go constants defined by `iota` repetition.

| Rule                                                                                 | Confidence     | Cap name            |
| ------------------------------------------------------------------------------------ | -------------- | ------------------- |
| Literal, or a constant local to a function or private to the module                  | Worth a look   |                     |
| An exported constant (TS `export`, a capitalized Go name, a Python name without `_`) | at most Maybe  | `exported-constant` |
| A name that looks like a debug or compile-time toggle                                | at most Unsure | `debug-name`        |

Debug-like names are matched by word, in any case style: `debug`, `trace`, `verbose`, `dev`, `development`, `profile`, `profiling`, plus `TYPE_CHECKING` and `__debug__` (so `isDebug`, `DEBUG_SQL`, `__DEV__` all count, `devices` does not).

### Possibly stale flags

A flag usage is one of:

- a call to an **OpenFeature** evaluation method (`getBooleanValue`, `get_boolean_value`, `BooleanValue` and the rest, in TS/JS, Python and Go; React hooks such as `useBooleanFlagValue`). The pattern pack in `packages/findings/src/packs/openfeature.json` cites the SDK source each entry was written from. A match is **strong** when the file imports the SDK, **weak** otherwise. In Go, only method calls count: `flag.String(name, default, usage)` is a package function, not a client;
- a call to a function you list in `flags.wrapperFunctions` (strong);
- an environment read whose key starts with a prefix in `flags.envPrefixes` (strong): `process.env.X`, `process.env["X"]`, `import.meta.env.X`; `os.environ["X"]`, `os.environ.get("X")`, `os.getenv("X")`; `os.Getenv("X")`, `os.LookupEnv("X")`.

A key that is not a string literal cannot be assessed: it is only counted ("unassessable usages"), and only for strong matches. An empty key is not a flag.

A flag is reported only when git history is usable, its key is not in `flags.longLived`, and **both** hold:

1. it was first introduced at least `flags.staleAfterDays` (default 90) days ago, and
2. every line that uses it was last changed at least that long ago.

| Rule                      | Confidence | Cap name    |
| ------------------------- | ---------- | ----------- |
| At least one strong usage | Maybe      |             |
| Only weak usages          | Unsure     | `weak-only` |

A stale flag is never rated Worth a look: age alone does not show that a flag is finished, and long-lived operational flags (kill switches, gradual rollouts) are legitimate.

### Possibly unused files

Reachability starts at every **entry point** and follows every resolver-proven edge (imports, dynamic imports with a literal path, re-exports, type-only imports and imports through barrels). In Python, importing a module also runs the `__init__.py` of every package above it, so those count as reached. A cycle of files that nothing reaches is one finding, and so is a Go package (its subject is the first file, its locations list every file).

Never reported: test code, generated files (`@generated`, Go's `Code generated ... DO NOT EDIT`), declaration files (`.d.ts`, `.pyi`) and paths under `ignore` or `findings.ignore`.

| Rule                                                                                                                                                                                                                                                                                                                        | Confidence     | Cap name                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------- |
| Not reached from any entry point                                                                                                                                                                                                                                                                                            | Worth a look   |                         |
| Under the literal path prefix of a dynamic import or of a path resolved at run time (`import(\`./pages/${x}\`)`, `import.meta.resolve(\`./${x}\`)`, `require.resolve("./x/" + n)`, `new URL(\`./w/${x}\`, import.meta.url)`), or imported only by such a file                                                               | at most Unsure | `dynamic-import-prefix` |
| Inside a convention path of a detected framework, or imported only by such a file                                                                                                                                                                                                                                           | at most Unsure | `framework-convention`  |
| Its package declares no entry point: no manifest entry (`package.json` `main`, `exports`, `bin`...; pyproject scripts and public modules; importable Go packages) and no `entryPoints` in `epoch.config.json`. Scripts, tool configs, conventions and tests are entry points too, but they do not show the list is complete | at most Maybe  | `convention-roots-only` |
| Changed within `staleAfterDays`                                                                                                                                                                                                                                                                                             | at most Maybe  | `recently-touched`      |
| Git history is not usable (not a repository, shallow clone, too short)                                                                                                                                                                                                                                                      | at most Maybe  | `history-unusable`      |
| A likely relation at or above the hint threshold (a co-change, shared-string or similarity hint edge, default 0.5, ADR-008) links it to a file an entry point reaches                                                                                                                                                       | at most Maybe  | `strong-hint`           |

A file's package is the deepest folder above it with a package manifest (`package.json`, `pyproject.toml`, `setup.cfg`, `setup.py`, `go.mod`); a folder with only a `tsconfig.json` is not a package.

When several caps apply, the lowest wins, and all of them are listed with the finding.

Every unreachable-file finding carries this caveat: _"Not referenced by analyzed code; may be loaded by tooling, reflection, or runtime configuration."_

## Entry points

Entry points are read from files as data; nothing is run.

| Language | Entry points                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TS/JS    | `package.json` `main`, `module`, `types`, `typings`, `browser`, `bin` and every `exports` condition, mapped from build output back to source through tsconfig `outDir`/`rootDir` (or, without an `outDir`, from `dist`, `lib`, `build`, `out`, `esm` or `cjs` back to `src`, preferring a `.cts` or `.mts` source for a `.cjs` or `.mjs` output); files named in `scripts` and in GitHub Actions workflows (`.github/workflows/*.yml`: `run:` commands and github-script imports); tool config files (`*.config.*`, `.*rc.*`) and every source path they name as a string; paths named in Nx, Angular and NestJS JSON configs; `main.*`, `cli.*`, `bin/*` and `#!` scripts; `<script src>` of HTML pages; what Vue, Svelte, Astro and MDX files import |
| Python   | `__main__.py`; files with an `if __name__ == "__main__"` guard or a `#!` line; `manage.py`, `wsgi.py`, `asgi.py`; Sphinx's `conf.py`, `noxfile.py`, `setup.py`; scripts and entry points declared in `pyproject.toml` (`[project.scripts]`, `[project.gui-scripts]`, `[project.entry-points.*]`, Poetry scripts and plugins) and `setup.cfg`; every public module (no path segment starting with `_`) of a distributable package, one with a build system (`[build-system]`, `setup.py` or `setup.cfg`)                                                                                                                                                                                                                                                |
| Go       | `package main`; every package other modules can import (any package outside an `internal/` directory)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| All      | Test files; files matching `entryPoints` in `epoch.config.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

A library's public API counts as used by definition. So in a library only private modules (Python), `internal/` packages (Go) and files outside the published entry points (TS) can be candidates.

## Frameworks that load files by convention

When a project depends on one of these, files in its convention paths, and files only they import, are capped at Unsure, and Epoch suggests listing what it loads under `entryPoints`. The list is data in `packages/findings/src/frameworks.json`; each entry cites the framework's docs.

| Framework                     | Detected by                 | Convention paths                                                                                                                                          |
| ----------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js                       | `next`                      | `app/`, `pages/` (also under `src/`), `middleware`, `proxy`, `instrumentation` files                                                                      |
| Nuxt                          | `nuxt`                      | `components/`, `composables/`, `layouts/`, `middleware/`, `pages/`, `plugins/`, `utils/` (also under `app/`), `server/`, `shared/`, `modules/`, `layers/` |
| SvelteKit                     | `@sveltejs/kit`             | `src/routes/`, `src/service-worker`, hooks and params files                                                                                               |
| Astro                         | `astro`                     | `src/pages/`, `src/middleware`, `src/content.config`                                                                                                      |
| Remix                         | `@remix-run/dev`            | `app/routes/`, `app/root`, `app/entry.client`, `app/entry.server`                                                                                         |
| React Router (framework mode) | `@react-router/dev`         | `app/` (its `routes.ts` names route modules by path)                                                                                                      |
| Gatsby                        | `gatsby`                    | `src/pages/`, `src/api/`, `src/templates/`, `gatsby-*` files, `plugins/`                                                                                  |
| VitePress                     | `vitepress`                 | `.vitepress/`, `*.paths.*` and `*.data.*` loaders                                                                                                         |
| Storybook                     | `storybook`, `@storybook/*` | `.storybook/`, `*.stories.*`                                                                                                                              |
| Vite                          | `vite`                      | `public/` folders (under the Vite root, which may be a subfolder), copied to the output as-is                                                             |
| Django                        | `django`, or a `manage.py`  | `migrations/`, `management/commands/`, `templatetags/`, `settings/`, `admin.py`, `apps.py`, `models.py`, `urls.py`, `settings.py`                         |

## Git history

- **"Now" is HEAD's commit date.** Ages are measured against the last commit, not the calendar, so findings depend only on the repository's state (a dormant repository is judged by its own last commit).
- **Blame reads HEAD's tree**, ignoring whitespace-only changes (`-w`) and the revisions listed in `.git-blame-ignore-revs`, if the repository has that file.
- **Uncommitted lines count as changed now.** They are found by comparing the working file with HEAD's version inside Epoch, so git never reads the working tree, and no repository-configured filter, textconv or diff driver runs.
- **History is unusable** when the folder is not the top of a git repository, when it is a shallow clone, or when its history is shorter than `staleAfterDays`. Then possibly stale flags are not checked, unreachable files are capped at Maybe, and the app and the CLI say why.
- Answers are cached per HEAD in Epoch's cache, so re-analyzing the same commit (for example while the watcher runs) does not ask git again.

## Configuration: `epoch.config.json`

Optional, at the project root, written by you and never by Epoch. Unknown keys and invalid values produce a warning, and the defaults apply. Globs support `*`, `**`, `?` and `{a,b}`; they are matched by Epoch's own matcher, never turned into regular expressions.

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

| Key                      | Default    | Effect                                                                      |
| ------------------------ | ---------- | --------------------------------------------------------------------------- |
| `entryPoints`            | `[]`       | Extra entry points (globs)                                                  |
| `ignore`                 | `[]`       | Removed from analysis entirely (globs)                                      |
| `flags.wrapperFunctions` | `[]`       | Your own flag-reading functions; the first argument is the key              |
| `flags.envPrefixes`      | `[]`       | Environment variables starting with these are flags (plain prefix match)    |
| `flags.longLived`        | `[]`       | Flag keys that are meant to stay; never reported as stale                   |
| `flags.staleAfterDays`   | `90`       | The age for stale flags and the window for "recently changed"               |
| `findings.minConfidence` | `"medium"` | The lowest level the banner counts, the panel shows first and the CLI lists |
| `findings.ignore`        | `[]`       | Findings in these paths are hidden; the files are still analyzed (globs)    |

## Reviewing findings

- **In the app:** a calm banner over the canvas counts the open findings at your `minConfidence` level; **Review** opens the Findings view (also Ctrl/Cmd+3). Filter by kind and level; select a finding to see, in this order, what to keep in mind, why it was flagged, why it got its rating, a suggested next step, where it is (with a read-only preview of the lines) and **Dismiss** (with an optional note) or **Restore**. Nodes with open findings get a muted dashed ring; **Findings only** fades the rest of the graph.
- **Dismissals** are kept in Epoch's data folder (on Linux `~/.local/share/epoch`, on macOS `~/Library/Application Support/epoch`, on Windows `%LOCALAPPDATA%\epoch\Data`; `EPOCH_DATA_DIR` overrides it), one file per project, never in the project. Finding ids contain no line numbers, so a dismissal survives edits that move code around.
- **In the CLI and CI:** `epoch findings <path> [--json] [--min-confidence <level>] [--fail-on <level>] [--include-dismissed]`. Exit codes: 0 success, 1 error, 2 when a non-dismissed finding is at or above `--fail-on`.

## Limits

Static analysis sees only the analyzed code. Expect candidates that are in fact used when:

- **tooling loads a file:** build configs that compute paths, tsconfig projects a test script type-checks, bundle inputs passed on the command line, Docker or shell scripts, task runners. Epoch reads paths that package scripts, GitHub workflows and tool configs name as plain strings, not paths they compute;
- **runtime configuration loads it:** plugin registries, dependency injection, Django settings that name classes by dotted string, anything loaded by `require(variable)` or `importlib` without a literal prefix;
- **a language Epoch does not analyze imports it**, beyond the Vue, Svelte, Astro, MDX and HTML imports it reads;
- **it is a standalone script** run by hand (benchmarks, one-off migrations); whether that is "unused" is your call;
- **reachability goes through tests only:** test files are entry points, so a file used only by its tests counts as reached (reporting those is planned for later);
- **build tags or conditional compilation** decide what is used (Go build tags are not evaluated);
- **history is approximate:** renamed or moved files can look newer or older than they are, and a flag's first appearance is found by a plain-text search scoped to the files that use it today;
- **flag providers are not consulted:** a flag can be fully rolled out in code and still switched for some users in your provider.

## Reducing false positives

1. Add what tools load to `entryPoints` (globs), for example `"scripts/**"`, `".github/scripts/*.js"`, or a framework's route folder.
2. Add long-lived flags to `flags.longLived`.
3. Hide whole areas with `findings.ignore` (they are still analyzed and still count for reachability).
4. Raise `findings.minConfidence` to `"high"` for the banner and the CLI.
5. Dismiss individual findings with a note explaining why; the note stays with you, not the project.
