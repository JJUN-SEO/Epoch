# ADR-020: Coverage reports: formats, discovery and live refresh

- **Status:** Accepted
- **Date:** 2026-10-24
- **Milestone:** M4 follow-up (risk fragility)

## Context

The maintainer had never seen a file with test coverage in the app. Coverage feeds the risk tier's fragility (below 50% line coverage is fragile, ADR-015) and the details panel, so without it risk falls back to file size alone. Epoch never runs tests (CLAUDE.md principle 8), so it can only read a report a test runner already wrote.

Why nothing showed, from the code at `7d1f1c1`:

1. **Two formats, four places.** Epoch read lcov and Cobertura XML, and only at `coverage/lcov.info`, `coverage/cobertura-coverage.xml`, `coverage.xml` or `lcov.info` in the repository root.
2. **The usual tools write something else.**
   - vitest's default reporters are `text`, `html`, `clover` and `json`, so it writes `coverage/clover.xml` and `coverage/coverage-final.json`.
   - Jest's defaults are `clover`, `json`, `lcov` and `text`. Its `coverage/lcov.info` was found, at the repository root only.
   - coverage.py writes a SQLite file, `.coverage`, until someone runs `coverage xml` or `coverage lcov`.
   - `go test -coverprofile` writes a Go cover profile, which Epoch did not read.
3. **Monorepos.** Each package's runner writes into its own folder, which was never looked at.
4. **No live refresh.** The watcher skips `coverage/` (a folder Discover skips by name), so a report written after the project was opened appeared only on reopening.
5. **No way to point at a report** in the app.

## Sources (read 2026-10-24)

- **vitest 5.0.4:** `coverageConfigDefaults` in the installed package: `reportsDirectory: "./coverage"`, `reporter: ["text", "html", "clover", "json"]`.
- **Jest:** `docs/Configuration.md` at jestjs/jest `61050e93`: `coverageReporters` default `["clover", "json", "lcov", "text"]`.
- **Istanbul's line rule:** `FileCoverage.getLineCoverage()` in @vitest/istanbul-lib-coverage 1.0.2, vitest's copy of istanbul-lib-coverage. A statement counts on its start line, and a line keeps the highest count of the statements starting there.
- **Clover:**
  - Istanbul's Clover reporter: its output, in the fixtures.
  - PHPUnit's writer: `src/Report/Clover.php` at sebastianbergmann/php-code-coverage `e61991d1`.
- **coverage.py:** `doc/config.rst` and `doc/dbschema.rst` at nedbat/coveragepy `79268ee5`:
  - the XML report defaults to `coverage.xml` and the LCOV report to `coverage.lcov`;
  - "Coverage.py stores data in a SQLite database, by default called `.coverage`."
- **Go:**
  - `go help testflag` (go 1.24.7): `-coverprofile cover.out`.
  - `cover/profile.go` at golang/tools `86210da6`: the line format `name.go:line.column,line.column numberOfStatements count`, and the merging of blocks at the same position (`|=` in `set` mode, `+=` otherwise).

**Real reports as test data.** `packages/engine/src/fixtures/coverage-reports/` holds reports the tools wrote on tiny projects: vitest's four formats from one run, coverage.py's lcov and XML, and a Go profile. Its README records versions and commands.

## Decision

1. **Three more formats.** Istanbul JSON, Clover XML and Go cover profiles are added. Each is counted the way its own tool counts it:
   - **Istanbul JSON** (`coverage-final.json`): a statement counts on its start line, and a line is hit if any statement starting there was.
   - **Clover XML:**
     - `stmt` and `cond` lines count; `method` lines mark a declaration and are skipped;
     - the path is the `path` attribute (Istanbul), else `name` (PHPUnit writes the full path there).
     - Limit: PHPUnit writes a method whose first line is executable (a one-line method) only as a `method` line, so that line goes uncounted. PHP is not analyzed yet.
   - **Go profiles:**
     - the unit is the statement, as in `go test`'s percentage;
     - a block repeated at the same position, by several test binaries, counts once, hit if any run hit it.

   **Evidence:** the formats of one run agree.
   - vitest's lcov, Istanbul JSON, Clover and Cobertura all give `math.ts` 3 of 6 lines and `untested.ts` 1 of 2, the tool's own summary.
   - coverage.py's lcov and XML both give 6 of 9 and 1 of 2, its summary.
   - The Go profile gives 3 of 6 and 0 of 1 statements, `go test`'s 50.0% and 0.0%.

2. **coverage.py's `.coverage` file is not read.**
   - It is a SQLite database written by the project's own test run. Reading it means opening an untrusted database file with a SQL engine, and its schema is versioned by coverage.py.
   - `coverage xml` or `coverage lcov` turns it into a report Epoch reads, so the app names those commands.
   - JaCoCo stays next, once a JVM language is analyzed.
3. **Where Epoch looks.** In the repository root and in every project folder the adapters found (`package.json`, `pyproject.toml`, `go.mod`, `tsconfig.json`...). Each group below is one tool's output from one run, so only its first report found is read:
   - `coverage/lcov.info`, `coverage/coverage-final.json`, `coverage/clover.xml`, `coverage/cobertura-coverage.xml` (Jest, vitest, c8, nyc);
   - `coverage.xml`, `coverage.lcov` (coverage.py);
   - `cover.out`, `coverage.out` (Go);
   - `lcov.info`.
4. **One report per file.** A file takes its coverage from the most specific report: the deepest folder first, then the group order above. Coverage never adds up across reports. `AnalysisMeta` lists every report used and how many files each supplied.
5. **Paths.**
   - A found report's relative paths are read from its folder, where the tool ran.
   - Absolute paths are matched against the whole repository, as before.
   - A Go profile's import paths go through the `go.mod` module that owns them (the longest module path that fits). Paths in no module here, such as dependencies under `-coverpkg`, count as unmatched rather than risk a suffix match.
6. **A report chosen in the app** (`coverageReport`, repo-relative) replaces looking.
   - It is read through the root-confined reader like any other file, so a path outside the project reads as missing.
   - A missing, oversized or unrecognized report is reported in `AnalysisMeta`, never thrown, and the analysis goes on without coverage.
   - The CLI's `--coverage <file>` keeps its meaning: any path, and an unusable file is an error.
7. **Live refresh.** The watcher watches every report path the analysis looked at, inside folders Discover skips too. There it watches only the report files, not the HTML report beside them.

## Consequences

- `AnalysisMeta.coverage` becomes `{ reports: [...], chosen? }`. It used to be one report or `null`. The CLI prints one line per report.
- CLAUDE.md's coverage-format line names the formats read, then JaCoCo.
- **Cost.** Up to nine file checks per project folder, and at most one parsed report per group per folder. Reports stay capped at 64 MB.
- **Limits:**
  - A report older than the code is used as it is, and the UI says a report may be older than the code.
  - Lines are matched by path, never by content.
