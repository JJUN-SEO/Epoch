# Test coverage

Test coverage feeds the risk tier: a file whose tests run less than half of its lines counts as fragile, like a file over 300 lines ([ADR-015](decisions/ADR-015-risk-tiers.md)). The details panel shows each file's coverage next to its size. Without a report, risk judges fragility by size alone.

**Epoch never runs your tests.** It reads the report your test runner already wrote, the same way it reads your code: as data, on your machine. The decisions behind this page are in [ADR-020](decisions/ADR-020-coverage-reports.md).

## Getting a report

Run your tests with coverage, the way you normally would:

| Tool   | Command                                  | Writes                                                                      |
| ------ | ---------------------------------------- | --------------------------------------------------------------------------- |
| Vitest | `npx vitest run --coverage`              | `coverage/coverage-final.json` and `coverage/clover.xml` (its defaults)     |
| Jest   | `npx jest --coverage`                    | `coverage/lcov.info`, `coverage/coverage-final.json`, `coverage/clover.xml` |
| pytest | `coverage run -m pytest && coverage xml` | `coverage.xml`                                                              |
| Go     | `go test -coverprofile=cover.out ./...`  | `cover.out`                                                                 |

Epoch reads lcov, Cobertura XML, Clover XML, Istanbul JSON (`coverage-final.json`) and Go cover profiles. For coverage.py, run `coverage xml` or `coverage lcov` after the tests: Epoch does not read its `.coverage` database file.

## Where Epoch looks

In the project folder and in every package folder it finds (a folder with `package.json`, `pyproject.toml`, `go.mod` or `tsconfig.json`), for:

- `coverage/lcov.info`, `coverage/coverage-final.json`, `coverage/clover.xml` or `coverage/cobertura-coverage.xml`;
- `coverage.xml` or `coverage.lcov`;
- `cover.out` or `coverage.out`;
- `lcov.info`.

In a monorepo, each package's own report covers that package. When reports overlap, a file takes its coverage from the most specific one (the deepest folder), so nothing is counted twice. Paths in a package's report are read from that package's folder, and a Go profile's import paths go through the `go.mod` module they belong to.

A report written while the project is open shows up at once: the app watches these files, but not the HTML report next to them.

## Choosing a report by hand

If your report has another name or lives somewhere else, click the coverage item in the status bar and choose **Choose report…**. Pick a file inside the project folder; Epoch refuses anything outside it. The choice is remembered for the project, in Epoch's own app data (never in your project), and replaces looking. **Look for reports again** forgets it.

The command line takes any report with `epoch analyze <path> --coverage <file>` ([cli.md](cli.md)).

## Limits

- A report older than the code is used as it is. Lines are matched by file path, not by content, so coverage for a file that changed since the test run can be off.
- Report files over 64 MB are not read.
- JaCoCo (Java) is not read yet; no JVM language is analyzed yet.
