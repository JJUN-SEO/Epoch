# ADR-004: Cache design (FileFacts in SQLite, resolution recomputed)

- **Status:** Accepted
- **Date:** 2026-10-14
- **Milestone:** M2

## Context

CLAUDE.md "Local cache" sets the rules:

- cache `FileFacts` per file, keyed by contents, adapter id, adapter version and `extractorConfigHash`;
- recompute resolution, the graph and findings on every run;
- store no source;
- keep one per-user cache, shared by the app and the CLI, with owner-only permissions.

PLAN.md M2 asks for SQLite through `better-sqlite3`, WAL mode, schema migrations, change detection, and a decision on when (if ever) to cache resolution, made from `pnpm bench` numbers.

## Options and evidence

| Question         | Options                                                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                     | Choice                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store            | `better-sqlite3`; Node's built-in `node:sqlite`                                             | `better-sqlite3` 13.0.3 (MIT) ships N-API prebuilds for darwin, linux and linuxmusl (x64, arm64) plus win32 inside the npm tarball, with no install script, so `allowBuilds` stays empty. N-API is ABI-stable, so Electron should load the same binary (checked in M3). `node:sqlite` runs on Node 24.21.0 without a warning, but CLAUDE.md names `better-sqlite3` and I have not verified that Electron's Node includes it. | `better-sqlite3` 13.0.3                                                                                                                                                                              |
| Location         | `env-paths`; a pure function in `core`                                                      | Same OS conventions (Apple's Caches folder, `%LOCALAPPDATA%`, XDG) either way; a pure function keeps `core` free of I/O and adds no dependency.                                                                                                                                                                                                                                                                              | `resolveCacheDir` in `core`, with an `EPOCH_CACHE_DIR` override                                                                                                                                      |
| Facts key        | contents + adapter id + version + extractor config                                          | A grammar upgrade can change facts even if nobody bumps the adapter version (cache poisoning, a PLAN pitfall).                                                                                                                                                                                                                                                                                                               | The CLAUDE.md key **plus a parser fingerprint** (the `web-tree-sitter` and grammar package versions). A golden test fingerprints extract output per adapter version and fails on an unbumped change. |
| Change detection | `git diff` against the last commit, with a hash fallback; a stat manifest plus content hash | On vitest (2,400 files, warm OS cache), `stat` of every file took 6–10 ms and read plus sha256 of every file 25–36 ms, while parsing took about 2 s. `git status` and working-tree diffs can run commands configured in an untrusted repository's own `.git/config` (`core.fsmonitor`, clean filters), which breaks CLAUDE.md principle 8.                                                                                   | **Stat manifest plus content hash** for every folder. Git runs only for `--since`, as a tree-to-tree diff (details below).                                                                           |
| Resolution cache | cache resolved edges with dependency tracking; recompute every run                          | Measured below.                                                                                                                                                                                                                                                                                                                                                                                                              | **Recompute every run** (unchanged CLAUDE.md rule)                                                                                                                                                   |

## Decision

**Store.** `SqliteCacheStore` in `engine`:

- WAL mode, `busy_timeout` 5 s, `synchronous=NORMAL`; a test writes from two connections.
- Schema migrations through `PRAGMA user_version`. A database written by a newer Epoch is refused, never overwritten. One SQLite cannot read is renamed `*.corrupt-<time>` and rebuilt; the cache is derived data.
- Every cached value is re-validated with the `CachedFacts` schema on read; an invalid row is dropped and counts as a miss.
- The directory is `0700` and the database `0600`; SQLite gives `-wal` and `-shm` the same mode (tested on POSIX). On Windows the per-user ACL of `%LOCALAPPDATA%` applies.
- `MemoryCacheStore` passes the same contract suite and is used in tests.

**What is cached:**

- `FileFacts`, plus a flag for files the parser had to recover from syntax errors (a warm run has no syntax tree to check);
- per-repo manifests (path, size, mtime, ctime, content hash) and the last analyzed commit, read from `.git` as plain files;
- derived values for early cutoff (`recomputeIfChanged`, used from M6).

No file contents or excerpts are stored; a test scans the database file for every fixture source line.

**Change detection** (one rule for git and non-git folders):

- A file keeps its stored hash, without being read, when its size, mtime and ctime match the manifest, and it last changed at least 2 s before the previous scan started. That's git's racy-clean rule, and 2 s covers FAT's mtime resolution. ctime catches tools that restore mtimes (tar, `rsync -t`).
- Every other file is read and hashed; a late read (an evicted entry) is keyed by the bytes actually read.
- Default runs spawn no process.

**`--since <commit>`:**

- Re-reads every file changed between `<commit>` and `HEAD`, using a tree-to-tree `git diff`.
- Git is hardened: `core.fsmonitor=false`, `--no-pager`, `--no-ext-diff`, `--no-textconv`, `GIT_OPTIONAL_LOCKS=0`, no prompts.
- The commit is resolved with `rev-parse` first, and option-like input is refused before any process starts.

**Tracked files.** Discovery reads `.git/index` (formats 2–4, SHA-1 and SHA-256) as data, so a file git tracks is never hidden by `.gitignore`. This was found on zod, whose `packages/zod/.gitignore` lists `**/package.json`. `.epochignore` still applies to tracked files.

**Eviction.** Least-recently-used facts and derived values are evicted until their payload fits a cap. The default cap is 1 GiB: a default, not a measured choice. `epoch cache stats | clear | prune [--max-size <MB>]` manage the cache by hand.

**Resolution caching: not now.** From the M2 run of `pnpm bench` (`docs/benchmarks/typescript-performance.md` as of commit `dcca092`; median of 5 runs, the host recorded there):

| Repository           | Cold analysis | Warm, unchanged | Resolution share of warm | 50 files edited |
| -------------------- | ------------- | --------------- | ------------------------ | --------------- |
| vitest (2,400 files) | 3.37 s        | 1.33 s          | 986 ms (74%)             | 1.48 s          |
| zod (522 files)      | 1.58 s        | 306 ms          | 184 ms (60%)             | 529 ms          |

The FileFacts cache removes parsing from warm runs (3.37 s → 1.33 s on vitest), and resolution is now most of what remains. I'm still not caching it:

1. Correctness needs dependency tracking. A file's resolutions change when any tsconfig, package.json or file existence they consulted changes, and those consultations happen inside TypeScript's resolver.
2. A warm run on a 2,400-file monorepo is already about 1.3 s.
3. Cheaper first steps exist: profiling and speeding up the resolver within a single run, which needs no ADR.

Revisit this when the M4 watcher needs sub-second updates. At that point, resolve only the changed files, plus the files whose imports could resolve differently, with explicit dependency tracking and a new ADR.

## Consequences

- The equivalence property test (fast-check: random edits, adds, deletes, renames and tsconfig changes) guards the whole design. Incremental must equal cold, byte for byte. A deliberately broken change detector is caught and shrunk to two steps.
- Warm runs are bounded by resolution. On vitest the change-detection stage is the next target (about 0.2 s: stat plus 2,400 cache reads, each schema-validated and LRU-touched).
- `allowBuilds` stays empty; the Electron ABI check moves to M3.

## Sources

- better-sqlite3 13.0.3 npm tarball (`package.json`, `lib/binding.js`, `prebuilds/`), read after `npm pack`. https://github.com/WiseLibs/better-sqlite3
- Git index format: https://git-scm.com/docs/index-format. Racy git: https://git-scm.com/docs/racy-git
- XDG Base Directory spec: https://specifications.freedesktop.org/basedir-spec/latest/. Apple File System Programming Guide (Caches): https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html. Windows Known Folders: https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid
- Benchmarks: `docs/benchmarks/typescript-performance.md` (`pnpm bench`) and `docs/benchmarks/typescript.md` (`pnpm bench:accuracy`).
