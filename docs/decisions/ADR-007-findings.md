# ADR-007: Findings — flag patterns, entry points, frameworks, history and the rubric in practice

- **Status:** Accepted. The review sheet was reviewed by Claude at the maintainer's request (not by a human); the rubric was tuned once in response (see "Rubric tuning")
- **Date:** 2026-10-15, amended 2026-10-16
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

- **TS/JS:** `package.json` `main`, `module`, `types`, `typings`, `browser`, `bin`, every `exports` condition, mapped from output to source through tsconfig `outDir`/`rootDir`, or, without an `outDir`, from a bundler's `dist`/`lib`/`build`/`out`/`esm`/`cjs` back to `src` (a `.cjs` or `.mjs` output prefers a `.cts` or `.mts` source, as TypeScript emits them); files named in `scripts`, and in GitHub Actions workflows (`.github/workflows/*.yml` at the root: `run:` commands and github-script imports, tokens split on characters a path cannot hold, relative to the root); tool config files (`*.config.*`, `.*rc.*`) and every source path they name as a string literal (comments skipped); paths named in `project.json`, `angular.json`, `workspace.json`, `nest-cli.json` (relative to the file or the workspace root); `main.*`, `cli.*`, `bin/*`, `#!` scripts; `<script src>` of every HTML page; and what Vue, Svelte, Astro and MDX files import, resolved by the TS resolver (so tsconfig aliases apply). Test code: `*.test.*`, `*.spec.*`, and `test/`, `tests/`, `__tests__/`, `__mocks__/`, `__fixtures__/` folders.
- **Python:** `__main__.py`, `if __name__ == "__main__"` guards (fixed-string search) and `#!` scripts; `manage.py`, `wsgi.py`, `asgi.py`; `conf.py` (Sphinx), `noxfile.py`, `setup.py`; `[project.scripts]`, `[project.gui-scripts]`, `[project.entry-points.*]`, Poetry `scripts` and `plugins`, `setup.cfg` `[options.entry_points]`; and **every public module of a distributable package**. A package is distributable when `pyproject.toml` declares a `[build-system]` (and not Poetry's `package-mode = false`), or `setup.py`/`setup.cfg` exists; a module is public when no path segment starts with `_` and every folder down from the source root is a regular package. An application with a `pyproject.toml` but no build system is not a library, so its modules can be candidates.
- **Go:** `package main` (read from the file head, past comments and build constraints), and **every package outside `internal/`**, since other modules can import it.
- **All:** test files, and `entryPoints` globs from `epoch.config.json`.

A library's public API is reachable by definition; without this, every library looks unused.

`convention-roots-only` follows CLAUDE.md's wording, "no manifest or config entry point was mapped to source", per **package**: the deepest folder above the file with a package manifest (`package.json`, `pyproject.toml`, `setup.cfg`, `setup.py`, `go.mod`; adapters mark these roots with `ProjectRoot.package`). The cap applies unless a root with reason `manifest`, or one from `epoch.config.json` `entryPoints`, belongs to that package. Script, tool-config, convention and test roots still count for reachability, but they do not lift the cap: they show that some files run, not that the list of entry points is complete. A manifest entry that cannot be mapped to source produces no root. (The first version counted script and tool-config roots, scoped to any project root including tsconfig folders, and let roots of nested packages count for the workspace root; the review showed this let tooling packages such as benchmarks and bundle fixtures reach High.)

**Paths resolved at run time.** `import.meta.resolve(...)`, `require.resolve(...)` and `new URL(..., import.meta.url)` with a computed path are recorded like `import()` with a computed path: a `dynamic` import without a specifier, keeping the literal prefix (`` `./${name}` `` gives `./`). Files under that prefix get CLAUDE.md's dynamic-import-prefix cap. A literal path is not recorded yet, because it may name an asset rather than a module.

### 3. Framework list

`packages/findings/src/frameworks.json`, zod-validated, each entry citing pinned docs on GitHub: Next.js, Nuxt, SvelteKit, Astro, Remix, React Router (framework mode), Gatsby, VitePress, Storybook, Vite (its `public/` folders, which Vite copies as-is; added 2026-10-16 from vitejs/vite's docs at 928e721b) (npm dependencies) and Django (the `django` requirement or a `manage.py`). Dependencies are read from `package.json`, `pyproject.toml` and `requirements*.txt`. Convention paths are globs relative to the manifest's folder (see docs/findings.md). Extending the list needs an amendment to this ADR.

What a convention-loaded file imports is loaded with it. So an unreached file that only convention files (or files under a dynamic-import prefix) reach gets the same cap, with a caveat naming the importer. This reads CLAUDE.md's "inside a convention directory of a detected framework" and "covered by a dynamic-import prefix" as "may be loaded that way", which is what the caps are for.

### 4. Git history

- **"Now" is HEAD's committer date**, as for churn (M4). Findings stay a function of the repository, so the equivalence test still holds; a dormant repository is judged by its own last commit.
- **Usable** only when the analyzed folder is the top of a repository (`.git` inside it), the clone is not shallow (`.git/shallow`), and HEAD's date minus the root commit's date is at least `staleAfterDays`.
- **`firstIntroduced`:** `git log --reverse --format=%ct -S<key> HEAD -- <files that use it>`, oldest first. `-S` matches a fixed string ("look for differences that change the number of occurrences of the specified string", git 2.43.0's own option text); no regex is built from repository text.
- **`lastTouched`:** `git blame --porcelain -w [--ignore-revs-file .git-blame-ignore-revs] -L a,b HEAD -- file`, the newest `committer-time`. The flags were checked against `git blame -h` of git 2.43.0 (man pages are not installed in the container). Blame reads HEAD's tree; uncommitted lines are found by an in-process Myers line diff of HEAD's blob (`git cat-file blob HEAD:file`) against the working file, and count as "now". Unchanged lines are mapped to their HEAD line numbers first. Past 2,000 edits the diff gives up and treats the range as changed, which only makes code look newer.
- **`lastTouchedFile`:** `git log -1 --format=%ct HEAD -- file`, or "now" when the working file differs from HEAD's.
- Every call goes through the M4 hardening (`core.fsmonitor=false`, no pager, no signature display, `--no-ext-diff`/`--no-textconv` on log). No command reads the working tree, so no repository-configured filter runs.
- **Caching:** answers go to the cache's derived store, keyed by query, path and HEAD commit. They hold only timestamps.

**Measured cost** (docs/benchmarks/findings.md, 4 × Xeon 2.1 GHz, full clones, Findings stage cold / warm cache on the same HEAD): Flask 0.06 s / 0.07 s, cli/cli 0.13 s / 0.14 s, zod 4.11 s / 1.27 s (155 candidates, each a `git log` and a blob read), vitest 0.73 s / 0.44 s, open-feature/playground 0.31 s / 0.09 s. The cold cost grows with the number of candidates, not the size of the repository; the warm runs are what the watcher sees.

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

From docs/benchmarks/findings.md, after the tuning below:

- **Dead branches and stale flags are rare in maintained libraries.** Flask, cli/cli, zod and vitest have none at any level; open-feature/playground has 4 possibly stale flags (Maybe): its demo flags.
- **What remains High** is 11 files: zod's Zod 3 benchmark suite (9 files, orphaned when Zod 4 replaced its script), an unused module in zod's core, and a root shim in vitest's utils package.
- **zod vs knip:** 128 files both report (all 10 of Epoch's High among them), 27 only Epoch (none High: 1 Maybe, 26 Unsure), 6 only knip, each something Epoch treats as an entry point or test code, or not a JS/TS source.
- **vitest vs knip:** no overlap. Of Epoch's 10 candidates, vitest's own knip configuration declares 5 as entries and leaves 3 out of its scope; knip's "unused" `tester/*.ts` files are reached from the script `tester.html` loads. Tooling-loaded files are Epoch's main false-positive class, the one its caveat names.
- **Hindsight** (a year back, deleted by HEAD): zod High 0 of 10, Medium 1 of 27 (3.7%), vs 1.6% for files not reported (the Zod 3 suite is unused but was never deleted); vitest High 3 of 5 (60.0%), Medium 1 of 4, vs 17.5%. Small numbers, and a weak proxy.
- Fixing gaps found on these repositories (Go package functions, bundler output mapping, test folders, config path strings, comments in configs, Vue/Svelte/Astro/MDX imports, Nx/Angular/NestJS configs) took vitest from 307 candidates (shallow clone) to 12 before the review, without a per-repository exception.

## Rubric tuning

The maintainer asked Claude to make the review verdicts, since the sampled findings come from repositories they had not looked at. Each row was checked at its pinned commit: what imports, names, runs or documents the file (package scripts, runners, configs, workflows, docs), and for flags, where the key is read and defined. `yes` means nothing loads or runs it; `no` means something outside the analyzed imports does, including scripts, benchmarks, demos and examples meant to be run. **These verdicts are Claude's, not a human's**, so they are a stand-in for CLAUDE.md's human-reviewed sample until a person checks them; every reason is in the sheet's note column.

**Round 1** (the rubric as first written; `docs/benchmarks/findings-review-round1.csv`): High 6 of 24 (25.0%), Medium 1 of 26 (3.8%). The false positives fell into classes, each a gap in a rule rather than a quirk of one repository:

| Class                                    | Example                                                                      | Fix                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A runner resolves `./<name>` at run time | zod's `packages/bench/index.ts`: `import.meta.resolve(\`./${file}\`)`        | Paths resolved at run time keep their literal prefix (section 2)                                        |
| Tooling packages with no declared entry  | zod's bench and treeshake packages, vitest examples, repository-root scripts | `convention-roots-only` per package, counting only manifest and `epoch.config.json` entries (section 2) |
| Vite `public/` assets                    | vitest's browser client injector and error catcher                           | Vite in the framework list (section 3)                                                                  |
| Imported only by convention-loaded files | components only Next.js pages import                                         | Caps follow imports from convention-loaded files (section 3)                                            |
| `.cts` source of a `.cjs` output         | `@zod/resolution`'s CommonJS entry                                           | Prefer `.cts`/`.mts` sources (section 2)                                                                |
| Scripts GitHub workflows run or import   | vitest's `.github/scripts/*.js`                                              | Workflow paths are script roots (section 2)                                                             |

Left as known false positives, with the caveat and `entryPoints` as the remedy: bundle inputs passed on the command line, tsconfig projects that a test script type-checks, files loaded by a computed path (`resolve(rootDir, './x.cjs')`), vitest's `includeSource`, and hand-run scripts documented only in their own header.

**Round 2** (after the fixes; verdicts kept by finding id, 27 new rows reviewed the same way): High **11 of 11 (100%)**, Medium 8 of 39 (20.5%). The 11 High rows are every High finding the five repositories produce, and 10 of them were not in round 1, so they did not shape the fixes; still, 11 is small (a Wilson 95% interval of about 74% to 100%). The cost of the tuning: High is now rare (75 High findings became 11), and five of round 1's six true High findings moved to Maybe because their packages declare no entry point. Maybe precision stays low; the bar was set for High only.

## Consequences

- Library code is mostly out of scope for unreachable-file by design; applications and monorepo internals are where it helps.
- Files loaded by tooling remain the dominant false positive. The caveat says so, `entryPoints` fixes it per project, and the Findings view suggests it when a framework is detected.
- History-based answers cost one git process per candidate on the first run of a commit; the derived store makes later runs cheap.
- Adding a flag SDK or a framework means adding data with a cited source, not code.

## Amendment (2026-10-22): more references, and a held-out evaluation

**What changed.** The review sample's "no" rows and a run of Epoch on its own repository showed false-positive classes that static analysis can see. Each fix is a pattern the ecosystem documents (knip's entry-files and source-mapping docs; Vite's worker docs), built test-first with fixtures. None was made to clear one repository's output.

- **Literal runtime paths to source files** are dynamic imports: `new URL(…, import.meta.url)` (so `new Worker(new URL(…))`), `import.meta.resolve`, `require.resolve`, and `path.join/resolve` from `__dirname` or `import.meta.dirname`. Assets, package names and `node_modules` paths stay unrecorded.
- **A computed file name inside the module's own folder** records that folder as a literal prefix (the existing Low cap). These are not recorded:
  - a computed folder;
  - a computed path that climbs out of the folder;
  - a bare variable.

  vuejs/core showed how broad such prefixes can get: one build-config line capped every candidate in the repository.

- **Package scripts:**
  - build output maps back to source through the package that owns it;
  - a folder given to a runner means its index file;
  - `tsc --project` on a nested tsconfig makes the files it includes roots. A package's own tsconfig is excluded, since it compiles used and unused files alike.
- **Unbuilt outDir paths.** A relative path into an unbuilt tsconfig `outDir` resolves to its source.

**Effect** on Medium-or-higher unreachable-file candidates:

| Repository | Before | After                                   |
| ---------- | ------ | --------------------------------------- |
| Epoch      | 19     | 5 (hand-run scripts no code references) |
| zod        | 49     | 20                                      |
| vitest     | 6      | 5                                       |
| vuejs/core | 27     | 27                                      |

Unresolved imports grew by 3 to 5 per repository: runtime paths to build output that is not in a clone.

**Evaluation.** The reviewed sample now counts as the _design sample_: the fixes were made against its verdicts, so its precision (Maybe 20.5% → 42.1%) overstates what to expect on new code. A _held-out sample_ comes from trpc/trpc and fastapi/fastapi, repositories never used to design the detectors. Its review sheet (`docs/benchmarks/findings-heldout-review.csv`) is for a person to fill blind, and its precision is "not measured" until then. vuejs/core no longer counts as held out for findings, because the over-broad prefix cases were found on it.
