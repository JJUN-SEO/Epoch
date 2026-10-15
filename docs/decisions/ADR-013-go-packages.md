# ADR-013: Go packages as graph nodes, resolved from go.mod as data

- **Status:** Accepted
- **Date:** 2026-10-15
- **Milestone:** M4 (written before the Go adapter)

## Context

Go imports name packages, not files: every `.go` file in a directory shares one package scope, and an import path names that directory through the module path in `go.mod`. CLAUDE.md's data contract already allows for this (`kind: "package"`, `id: "pkg:<import path>"`, `contentHash` = a hash of the sorted member file hashes), and its "Known hard problems" table lists what makes Go hard: the `go.mod` module path, `internal/` packages, build tags, and package-level imports.

Two questions need an answer before the adapter:

1. How files become package nodes without changing CLAUDE.md's `LanguageAdapter` interface.
2. How imports resolve without running the go command on a user's project (principle 8, ADR-006).

## Sources of the rules

go.dev is not reachable from the development container, so every rule below was read from the Go 1.24.7 toolchain installed there (`go version go1.24.7 linux/amd64`): its `go help` texts and its source.

| Rule                                                                                                      | Source                                                                                        |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| go.mod and go.work lexing: `//` comments only, quoted and back-quoted strings, `(` `)` blocks             | `src/cmd/vendor/golang.org/x/mod/modfile/read.go` (`readToken`)                               |
| A `replace` right-hand side is a directory when it is `.`, `..`, starts with `./` or `../`, or is rooted  | `modfile/rule.go` (`IsDirectoryPath`, `parseReplace`)                                         |
| A module provides `path` at `moduleDir/rest`, unless a nested `go.mod` lies in between                    | `src/cmd/go/internal/modload/import.go` (`dirInModule`)                                       |
| A first path element without a dot is the standard library                                                | `src/cmd/go/internal/search/search.go` (`IsStandardImportPath`)                               |
| `internal`: importable only from the tree rooted at the parent of the last `internal` element             | `go help gopath` ("Internal Directories"); `src/cmd/go/internal/load/pkg.go` (`findInternal`) |
| Files and directories starting with `.` or `_`, and directories named `testdata`, are ignored             | `go help packages`; `src/go/build/build.go`                                                   |
| `./...` does not match packages under a `vendor` directory                                                | `go help packages`                                                                            |
| Relative import paths are not allowed inside a work space                                                 | `go help importpath` ("Relative import paths")                                                |
| The generated-file marker is a line matching `^// Code generated .* DO NOT EDIT\.$` before the first code | `go help generate`                                                                            |

## Decision

### 1. Granularity

- **Production files fold into one node per package**, `pkg:<import path>`. Its `loc` is the members' sum, its `exports` and `externals` the union, and its `contentHash` a sha256 of the sorted member hashes, one per line. Fan-in and fan-out are computed after folding.
- **`_test.go` files stay file nodes.** Tests are files, M5 uses them as roots, and a test file's own imports are worth seeing. Each one gets an `import` edge to the package of its directory, with the evidence `test file in the package directory`: an in-package test shares the package scope without importing it, and an external `_test` package is compiled against it. A directory with only test files has no package node, and its tests get no such edge.
- **Unresolved imports keep the member file as `from`**, with its line, so the user can find them.
- **Files outside any module** (no `go.mod` above them) stay file nodes: without a module there is no import path.

### 2. Where the mapping lives

`AdapterRegistration`, Epoch's own engine-level type beside the adapter, gains an optional `packageFor(path, ctx)` that returns `{ id, member }`. CLAUDE.md's `LanguageAdapter` interface is unchanged. `buildGraph` in `core` takes each file's package and a hash function for package nodes (the engine passes sha256), so `core` stays free of Node APIs and runs in the renderer.

### 3. Resolution, read as data

The adapter reads `go.mod` and `go.work` with its own small parser following the lexing rules above. It never runs the go command, never reads the module cache, and never touches the network.

- **Local modules** for a file:
  - the file's module (its nearest `go.mod`);
  - with a `go.work` above it that `use`s that module: every module the `go.work` uses;
  - the directory targets of `replace` directives in those `go.mod` files and in the `go.work`.
- **Order of checks** for an import path:
  1. `"C"` is cgo: external `cgo`.
  2. A relative path (`./x`, `../x`) is `unsupported-syntax`.
  3. A local module whose path is the longest path prefix provides it. With a nested `go.mod` in between, the nested module provides it instead (local if it is one of the local modules, else third-party).
     - A directory with production `.go` files is the package: `{ kind: "package", target: "pkg:<import path>" }`.
     - An existing path with no production files, or no directory at all, is `not-found`.
     - An `internal` path imported from outside its parent's tree is `not-found`: the go tool refuses it, and Epoch does not draw an edge the compiler rejects.
     - A replace target outside the project folder is `outside-project`.
  4. A first element without a dot is the standard library: external `go:<path>`.
  5. Anything else is third-party: external under the longest `require` module path that prefixes it, or under the import path itself when no `require` matches.
- **What is not source:** files under `vendor/`, `testdata/`, or any file or directory starting with `.` or `_`. Vendored imports resolve as third-party externals, the same as without vendoring.

### 4. What is not evaluated

- **Build constraints** (`//go:build`, `_linux.go`-style file names) are not evaluated: every production file in a directory joins its package, whatever its tags, including `//go:build ignore` helpers. The Go accuracy report measures what this costs.
- **Versions** in `require` and `replace` are not compared; a `replace` applies to every version of its module.
- **A module that `require`s a sibling module in the same repository** without a `replace` or a `go.work` gets an external, as the go command would fetch the published version.

### 5. Tier

Tier B until the accuracy measurement against `go list` (M4 benchmarks) meets the Tier A bar: precision and recall both at least 95%, with every disagreement explained.

## Consequences

- Blast radius and the status bar report packages and files separately (`byKind`), as Go mixes both granularities.
- `GraphNode` lists no members, so the UI cannot yet open a package's files; a members field would change CLAUDE.md's contract and needs its own approval.
- The folder map groups `pkg:` nodes by import path; the UI strips the import-path prefix all packages share, so packages line up with their test files' folders.
- `go list` is used only in the offline benchmark, on a pinned public repository, never by Epoch (ADR-006).
