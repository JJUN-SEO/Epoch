# Development

## Requirements

- **Node.js 24.21.0** (the Node bundled in Electron 43.7.7, which the app uses). With [fnm](https://github.com/Schniz/fnm), `fnm use` picks it up from `.node-version`. With nvm-windows, run `nvm install 24.21.0`, then `nvm use 24.21.0`. `pnpm install` fails on unsupported Node versions on purpose.
- **pnpm 11.28.2**: run `npm i -g pnpm@11.28.2`. Inside this repository, `pnpm -v` must print `11.28.2`.

Then:

```sh
pnpm install
pnpm check
```

`pnpm check` runs lint, typecheck and the tests, and works in any shell, including Windows PowerShell 5.1.

## Running the app

Electron 43 has no install script; its binary comes from a separate step, run once:

```sh
pnpm --filter @epoch-dev/app exec install-electron
pnpm dev           # the app with hot reload
pnpm package       # this OS's installers in packages/app/release/ (unsigned)
pnpm package:dir   # the unpacked app the e2e tests drive
pnpm e2e           # Playwright end-to-end and security tests against the built app
```

`pnpm e2e` runs against `pnpm build` output; set `EPOCH_E2E_TARGET=packaged` to test the `pnpm package:dir` output instead (the installers' fuses, except that Playwright needs Node's inspector; [ADR-018](decisions/ADR-018-distribution.md)). On Linux, run it under `xvfb-run` as a non-root user: the tests keep Chromium's sandbox on, which refuses root. Ubuntu 24.04 also needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` for that sandbox, as CI does.

Similarity hints need the local embedding model, which is not in the repository. `node scripts/fetch-model.mjs` downloads the pinned default into `models/` (checked against its sha256; behind a proxy, set `NODE_USE_ENV_PROXY=1`). `pnpm dev` and `pnpm package` then use it, and the CLI takes `--embedding-model models/<id>`. Without it, everything else works and similarity is off.

The headless CLI shares the engine; [cli.md](cli.md) covers it.

## Commands

| Command                      | What it does                                                         |
| ---------------------------- | -------------------------------------------------------------------- |
| `pnpm build`                 | Compile every package (`dist/`, and the app's `out/`)                |
| `pnpm dev`                   | Run the desktop app with hot reload                                  |
| `pnpm package`               | Build this OS's installers (unsigned)                                |
| `pnpm package:dir`           | Build the unpacked app the packaged e2e tests drive                  |
| `pnpm e2e`                   | Playwright end-to-end and security tests                             |
| `pnpm bench`                 | Analysis timings on pinned repositories                              |
| `pnpm bench:accuracy`        | TS/JS edge accuracy against dependency-cruiser                       |
| `pnpm bench:accuracy-python` | Python edge accuracy against grimp (needs a virtualenv)              |
| `pnpm bench:accuracy-go`     | Go edge accuracy against `go list` (needs a Go toolchain)            |
| `pnpm bench:watch`           | Watcher latency and churn cost                                       |
| `pnpm bench:findings`        | Findings on pinned repositories, the hindsight test and review sheet |
| `pnpm bench:risk`            | Risk tiers against later fix commits                                 |
| `pnpm bench:scorers`         | Hint scorers on a temporal holdout (`--embedding-model <dir>`)       |
| `pnpm bench:summaries`       | Summary cost, full and incremental (needs your provider key)         |
| `pnpm site:data`             | Regenerate the demo graphs with the CLI at the pinned commits        |
| `pnpm typecheck`             | Type-check every package                                             |
| `pnpm lint`                  | Prettier check, then ESLint on every package                         |
| `pnpm test`                  | Build, then run each package's Vitest suite                          |
| `pnpm check`                 | `lint`, `typecheck` and `test` in one command                        |
| `pnpm format`                | Format the repository with Prettier                                  |
| `pnpm telemetry:off`         | Turn off Turborepo telemetry for direct `turbo` use on this machine  |

The root scripts already run Turborepo with its telemetry turned off. `pnpm telemetry:off` is only needed if you also run `turbo` directly.

The tables in the README and in [results.md](results.md) are copied from the reports in [benchmarks/](benchmarks/) by `node scripts/readme-tables.mjs`; run it after regenerating a report. `pnpm lint` fails if a copied number no longer matches its report.

## The static site

`apps/site` is the landing page and the browser demo: the app's UI on a static `EpochApi` over the graphs in `apps/site/data/`. `pnpm build` builds it with everything else.

```sh
pnpm --filter @epoch-dev/site preview        # http://127.0.0.1:4173/Epoch/
pnpm --filter @epoch-dev/site exec playwright install chromium   # once
pnpm --filter @epoch-dev/site e2e            # Playwright against the preview
node scripts/site-size.mjs apps/site/dist    # gzip budgets per page and chunk
```

`pnpm site:data` clones the demo repositories into `.cache/site-repos`, checks each pinned commit, and rewrites `apps/site/data/`; two runs give byte-identical files. With the preview running, `node apps/site/scripts/record-demo.mjs` takes the landing page's screenshot and records a WebM, and `node scripts/make-gif.mjs <webm>` turns it into `docs/media/demo.gif` (both need ffmpeg).

## Releasing

`packages/app/package.json` is the version source. A matching `v<version>` tag builds and smoke-tests installers on macOS, Windows and Ubuntu runners, then creates a **draft** GitHub Release with all four installers and checksums. The maintainer checks the draft and publishes it. The site deploys from `main` through GitHub Actions when Pages uses **GitHub Actions** as its source. [ADR-018](decisions/ADR-018-distribution.md) records the distribution choices.

## Windows notes

- If `prettier --check` reports line-ending problems in a file you just created, run `pnpm format`. The repository stores LF everywhere (`.gitattributes`).
- Rename files only with `git mv`. For a change of case only, go through a temporary name: `git mv a.ts tmp.ts`, then `git mv tmp.ts A.ts`.

## Repository layout

```
packages/
  core/                 schemas, interfaces, pure graph algorithms
  adapters/typescript/  TypeScript/JavaScript language adapter (tier A)
  adapters/python/      Python language adapter (tier A)
  adapters/go/          Go language adapter, packages as nodes (tier A)
  findings/             dead-feature detectors, confidence rubric, flag pattern packs
  engine/               analysis pipeline, cache, parse worker pool, git churn, coverage, watcher
  cli/                  the headless `epoch` command
  app/                  Electron main process, preload, analysis host, packaging
  ui/                   React + Cytoscape renderer, written against EpochApi
  scorers/              hint scorers, model providers, the network wrapper and tripwire
  bench/                pnpm bench and the accuracy, findings, risk, scorer and summary benchmarks
apps/site/              landing page and browser demo (precomputed graphs, no backend)
scripts/                build, release, site data, README tables and size budgets
queries/                tree-sitter queries per language
fixtures/               conformance, findings and safety fixtures per language
docs/                   architecture, privacy, findings, CLI, results, decisions, benchmarks
```
