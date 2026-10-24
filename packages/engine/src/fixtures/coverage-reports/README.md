# Coverage reports from the real tools

Test data for `coverage.test.ts`: reports written by the tools themselves on tiny projects, kept byte for byte except that the scratch folder in absolute paths was replaced with `/work/cov-js` or `/work/cov-py`.

| Folder | Tool | Command |
| --- | --- | --- |
| `vitest/` | vitest 5.0.4 with @vitest/coverage-v8 5.0.4 (Istanbul reporters from @vitest/istanbul-lib-report 1.0.2) | `vitest run --coverage.enabled --coverage.provider=v8 --coverage.include='src/**' --coverage.reporter=lcov --coverage.reporter=json --coverage.reporter=clover --coverage.reporter=cobertura`, one run, four formats |
| `coveragepy/` | coverage.py 7.10.7, pytest 8.4.2 | `coverage run -m pytest`, then `coverage lcov` and `coverage xml` |
| `go/` | go 1.24.7 | `go test -coverprofile=coverage.out ./...` in module `example.com/covgo` |

The projects:

- **vitest:** `src/math.ts` (add and divide tested, `neverCalled` not) and `src/untested.ts` (imported by the test, `shout` never called). The tool's own summary: lines 3/6 and 1/2.
- **coverage.py:** `pkg/calc.py` (`never_called` not run), `pkg/sub/util.py` (imported, `shout` not run) and the test file. The tool's summary: 9 statements with 3 missed, and 2 with 1 missed.
- **Go:** `calc/calc.go` (`NeverCalled` and the zero-divisor branch not run) and `internal/util/util.go` (untested). `go test` printed 50.0% and 0.0% of statements.
