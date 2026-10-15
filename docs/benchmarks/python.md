# Python: real-repository run (counts only)

The Python adapter ships as tier B. Its accuracy has not been measured against a ground-truth tool yet (that is M4), so this report states counts and spot checks, not precision or recall.

## Method

- **Repository:** [pallets/flask](https://github.com/pallets/flask) at tag `3.1.3`, commit `22d924701a6ae2e4cd01e9a15bbaf3946094af65`, a shallow clone. It is never installed, built or run.
- **Command:** `EPOCH_CACHE_DIR=<empty directory> epoch analyze <flask> --json`, three runs.
- **Host:** linux x64, 4 × Intel Xeon @ 2.10 GHz, 16 GiB RAM, Node 24.21.0 (the host of `typescript-performance.md`).

## Counts

| Measure                          | Value                                                     |
| -------------------------------- | --------------------------------------------------------- |
| Python files analyzed            | 83 (src layout, `pyproject.toml`)                         |
| Cold analysis time (3 runs)      | 0.29 s, 0.30 s, 0.30 s                                    |
| Edges                            | 229: import 158, type-only 26, via-barrel 23, reexport 22 |
| Distinct externals               | 68: standard library 43, third-party 25                   |
| Unresolved imports               | 8: ambiguous 6, dynamic-specifier 2                       |
| Cycles (strongly connected sets) | 2                                                         |
| Skipped files, parse errors      | 0, 0                                                      |

Unresolved imports, all eight:

| File                                       | Line | Import                       | Reason            |
| ------------------------------------------ | ---- | ---------------------------- | ----------------- |
| `src/flask/cli.py`                         | 245  | `__import__(module_name)`    | dynamic-specifier |
| `src/flask/helpers.py`                     | 613  | `__import__(import_name)`    | dynamic-specifier |
| `tests/test_apps/blueprintapp/__init__.py` | 5    | `blueprintapp.apps.admin`    | ambiguous         |
| `tests/test_apps/blueprintapp/__init__.py` | 6    | `blueprintapp.apps.frontend` | ambiguous         |
| `tests/test_blueprints.py`                 | 177  | `blueprintapp`               | ambiguous         |
| `tests/test_blueprints.py`                 | 248  | `blueprintapp`               | ambiguous         |
| `tests/test_cli.py`                        | 43   | `cliapp.app`                 | ambiguous         |
| `tests/test_templating.py`                 | 408  | `blueprintapp`               | ambiguous         |

## Spot checks against the source

- `import flask` in `tests/test_basic.py` resolves to `src/flask/__init__.py`: `src/` is found as a source root (src layout).
- `from flask import g, session` in `examples/tutorial/tests/test_auth.py` traces through the `src/flask/__init__.py` barrel to `src/flask/globals.py` (evidence `via barrel src/flask/__init__.py`), and the tutorial's own `flaskr` package resolves from its project.
- `tests/test_apps/helloworld/wsgi.py` imports its sibling `hello.py`: a file outside a package also imports from its own directory, as Python does for scripts and pytest's default import mode does for tests.
- The six ambiguous imports name packages under `tests/test_apps/`, which `tests/conftest.py` puts on `sys.path` at run time (`monkeypatch.syspath_prepend`). Static analysis cannot see that, so Epoch leaves them unresolved rather than guessing.

## What this run changed

The first run labelled `blueprintapp`, `cliapp` and `hello` as third-party packages. Two resolution rules came out of it, each with a new conformance case (`script-directory`, `sys-path-edit`):

1. A file outside a package also searches its own directory.
2. A name found on no source root but defined somewhere in the project is unresolved (`ambiguous`), not third-party.

## Known limits seen here

- `config_module_app`, `config_package_app`, `installed_package`, `namespace`, `site_app` and `site_package` are counted as third-party. Flask's tests create those modules in temporary directories at run time; they are not in the repository.
- `_typeshed` is counted as third-party. It exists only in type-checker stubs and is imported under `TYPE_CHECKING`.
- The large cycle spans 19 files of `src/flask`. Inside it are 46 import, 25 type-only (`TYPE_CHECKING`) and 3 re-export edges; without the type-only edges, 13 of the 19 files still form a cycle.
