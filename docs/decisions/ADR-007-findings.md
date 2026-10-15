# ADR-007: Findings — flag patterns, entry points, frameworks, history and the rubric in practice

- **Status:** Accepted, pending the M5 gate (the human review of `docs/benchmarks/findings-review.csv` may still tighten caps; any change is recorded here)
- **Date:** 2026-10-15
- **Milestone:** M5

## Context

CLAUDE.md fixes what findings are (candidates, never verdicts), the three kinds, the data contracts and the confidence rubric. It leaves these choices to this ADR (PLAN.md register): where flag patterns come from, which files count as entry points in each language, which frameworks load files by convention, how git history is read and what it costs, the `staleAfterDays` default, and any tuning of the rubric. The answers to the M5 questions: OpenFeature only for now (other SDKs later), a High-precision bar of at least 90% on the reviewed sample, and `staleAfterDays` = 90.

## Decisions

### 1. Flag patterns: OpenFeature only, from the SDK sources

`packages/findings/src/packs/openfeature.json` holds 53 `FlagPattern` entries, each validated by zod and citing the file it was written from, pinned to a commit of `open-feature/js-sdk`, `python-sdk` and `go-sdk` on GitHub (openfeature.dev is not reachable from the development container; the SDK repositories are):

- TS/JS: `get{Boolean,String,Number,Object}{Value,Details}` (key at argument 0), import hints for the server, web, React, Angular and NestJS SDKs; React hooks `useFlag`, `useSuspenseFlag`, `use*Flag{Value,Details}`.
- Python: `get_*_{value,details}` and their `_async` forms (key at 0), hint `openfeature`.
- Go: `{Boolean,String,Float,Int,Object}{Value,ValueDetails}` and the short forms (key at 1, after the context), hint `github.com/open-feature/go-sdk/openfeature`.

Matching rules the contract leaves open:

- **Go evaluations are client methods.** A package-qualified call (`flag.String(name, default, usage)`, the operand being an imported package's name) or an unqualified call is not matched. On cli/cli, without this rule, the standard library's `flag.String` produced 1,180 bogus "unassessable" usages.
- **An empty key is not a flag** (cobra's `Flags().String("x", "", ...)` puts the default at the key's position).
- **The unassessable count covers strong usages only**: a weak, non-literal match says too little to be called a flag usage.

### 2. Entry points per language

"Now" and roots must make findings a function of the repository. The roots (all read as data):

- **TS/JS:** `package.json` `main`, `module`, `types`, `typings`, `browser`, `bin`, every `exports` condition, mapped from output to source through tsconfig `outDir`/`rootDir`, or, without an `outDir`, from a bundler's `dist`/`lib`/`build`/`out`/`esm`/`cjs` back to `src`; files named in `scripts`; tool config files (`*.config.*`, `.*rc.*`) and every source path they name as a string literal (comments skipped); paths named in `project.json`, `angular.json`, `workspace.json`, `nest-cli.json` (relative to the file or the workspace root); `main.*`, `cli.*`, `bin/*`, `#!` scripts; `<script src>` of every HTML page; and what Vue, Svelte, Astro and MDX files import, resolved by the TS resolver (so tsconfig aliases apply). Test code: `*.test.*`, `*.spec.*`, and `test/`, `tests/`, `__tests__/`, `__mocks__/`, `__fixtures__/` folders.
- **Python:** `__main__.py`, `if __name__ == "__main__"` guards (fixed-string search) and `#!` scripts; `manage.py`, `wsgi.py`, `asgi.py`; `conf.py` (Sphinx), `noxfile.py`, `setup.py`; `[project.scripts]`, `[project.gui-scripts]`, `[project.entry-points.*]`, Poetry `scripts` and `plugins`, `setup.cfg` `[options.entry_points]`; and **every public module of a distributable package**. A package is distributable when `pyproject.toml` declares a `[build-system]` (and not Poetry's `package-mode = false`), or `setup.py`/`setup.cfg` exists; a module is public when no path segment starts with `_` and every folder down from the source root is a regular package. An application with a `pyproject.toml` but no build system is not a library, so its modules can be candidates.
- **Go:** `package main` (read from the file head, past comments and build constraints), and **every package outside `internal/`**, since other modules can import it.
- **All:** test files, and `entryPoints` globs from `epoch.config.json`.

A library's public API is reachable by definition; without this, every library looks unused.

`convention-roots-only` is scoped to the file's project (the deepest project root holding it): the cap applies when no root with reason `manifest`, `script` or `config` lies inside that project. A manifest entry that cannot be mapped to source produces no root, so a project whose only manifest entries are unmapped gets the cap, which is CLAUDE.md's "no manifest or config entry point was mapped to source".

### 3. Framework list

`packages/findings/src/frameworks.json`, zod-validated, each entry citing pinned docs on GitHub: Next.js, Nuxt, SvelteKit, Astro, Remix, React Router (framework mode), Gatsby, VitePress, Storybook (npm dependencies) and Django (the `django` requirement or a `manage.py`). Dependencies are read from `package.json`, `pyproject.toml` and `requirements*.txt`. Convention paths are globs relative to the manifest's folder (see docs/findings.md). Extending the list needs an amendment to this ADR.

### 4. Git history

- **"Now" is HEAD's committer date**, as for churn (M4). Findings stay a function of the repository, so the equivalence test still holds; a dormant repository is judged by its own last commit.
- **Usable** only when the analyzed folder is the top of a repository (`.git` inside it), the clone is not shallow (`.git/shallow`), and HEAD's date minus the root commit's date is at least `staleAfterDays`.
- **`firstIntroduced`:** `git log --reverse --format=%ct -S<key> HEAD -- <files that use it>`, oldest first. `-S` matches a fixed string ("look for differences that change the number of occurrences of the specified string", git 2.43.0's own option text); no regex is built from repository text.
- **`lastTouched`:** `git blame --porcelain -w [--ignore-revs-file .git-blame-ignore-revs] -L a,b HEAD -- file`, the newest `committer-time`. The flags were checked against `git blame -h` of git 2.43.0 (man pages are not installed in the container). Blame reads HEAD's tree; uncommitted lines are found by an in-process Myers line diff of HEAD's blob (`git cat-file blob HEAD:file`) against the working file, and count as "now". Unchanged lines are mapped to their HEAD line numbers first. Past 2,000 edits the diff gives up and treats the range as changed, which only makes code look newer.
- **`lastTouchedFile`:** `git log -1 --format=%ct HEAD -- file`, or "now" when the working file differs from HEAD's.
- Every call goes through the M4 hardening (`core.fsmonitor=false`, no pager, no signature display, `--no-ext-diff`/`--no-textconv` on log). No command reads the working tree, so no repository-configured filter runs.
- **Caching:** answers go to the cache's derived store, keyed by query, path and HEAD commit. They hold only timestamps.

**Measured cost** (docs/benchmarks/findings.md, 4 × Xeon 2.1 GHz, full clones, Findings stage cold / warm cache on the same HEAD): Flask 0.07 s / 0.06 s, cli/cli 0.17 s / 0.18 s, zod 4.24 s / 1.35 s (156 candidates, each a `git log` and a blob read), vitest 0.93 s / 0.48 s, open-feature/playground 0.34 s / 0.10 s. The cold cost grows with the number of candidates, not the size of the repository; the warm runs are what the watcher sees.

### 5. Detectors and ids

- Pure, in `packages/findings`, with the history provider and the hash function injected.
- Ids hash the kind, the subject and a discriminator, never a line number: dead-branch uses the file, the condition's name (or "literal") and its ordinal among conditions of that name in the file; stale-flag the key; unreachable-file the subject file. A test checks that ids survive line moves.
- An unreached strongly connected component is one finding; a Go package is one finding (subject: its first file).
- Debug-like names (cap Low): the words `debug`, `trace`, `verbose`, `dev`, `development`, `profile`, `profiling` in any case style, plus `TYPE_CHECKING` and `__debug__`.

### 6. Where dismissals live

In the per-user **data** directory, beside but not inside the cache (the cache is safe to delete; dismissals are not): `~/.local/share/epoch` or `$XDG_DATA_HOME/epoch`, `~/Library/Application Support/epoch`, `%LOCALAPPDATA%\epoch\Data`; `EPOCH_DATA_DIR` overrides it. One owner-only JSON file per project (named by a hash of its path), written atomically; an unreadable file is set aside, not overwritten. The app's main process and the CLI share it.

### 7. `staleAfterDays` = 90, `minConfidence` = medium

Both are CLAUDE.md's defaults; 90 days was confirmed in the M5 questions. Neither is a claim about the right value: the review sheet is where evidence for tuning comes from.

### 8. Evaluation aids run only on pinned public clones

knip 6.38.0 (published 2026-09-23; no install scripts) is the ground truth for TS/JS unused files. It loads project configuration, so it runs from a scratch install, on the pinned public clones only, with their dependencies installed without lifecycle scripts, and never as part of Epoch (ADR-006). It is not a dependency of any workspace package.

## What the measurements showed

From docs/benchmarks/findings.md:

- **Dead branches and stale flags are rare in maintained libraries.** Flask, cli/cli, zod and vitest have none at any level; open-feature/playground has 4 possibly stale flags (Maybe), old demo flags.
- **zod vs knip:** 128 files both report, 28 only Epoch, 6 only knip; every knip-only file is something Epoch treats as an entry point or test code, or is not a JS/TS source.
- **vitest vs knip:** no overlap. vitest's own knip configuration declares 7 of Epoch's 12 candidates as entries (GitHub Actions scripts, Vite public-folder scripts) and leaves 3 more out of its scope; knip's 8 "unused" `tester/*.ts` files are reached from the script `tester.html` loads (`tester.ts`), which Epoch reads. Tooling-loaded files are Epoch's main false-positive class, the one its caveat names.
- **Hindsight** (a year back, deleted by HEAD): zod High 3.3% vs 1.6% for files not reported; vitest High 42.9% (3 of 7), Medium 25.0%, vs 17.5%. Small numbers, and a weak proxy.
- Fixing gaps found on these repositories (Go package functions, bundler output mapping, test folders, config path strings, comments in configs, Vue/Svelte/Astro/MDX imports, Nx/Angular/NestJS configs) took vitest from 307 candidates (shallow clone) to 12, without a per-repository exception.

## Rubric tuning

None yet. If High-confidence precision on the reviewed sample is below 90%, caps are tightened here (for example, files under folders that hold standalone scripts) and the benchmark is re-run before the gate.

## Consequences

- Library code is mostly out of scope for unreachable-file by design; applications and monorepo internals are where it helps.
- Files loaded by tooling remain the dominant false positive. The caveat says so, `entryPoints` fixes it per project, and the Findings view suggests it when a framework is detected.
- History-based answers cost one git process per candidate on the first run of a commit; the derived store makes later runs cheap.
- Adding a flag SDK or a framework means adding data with a cited source, not code.
