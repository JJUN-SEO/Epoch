# Epoch

> **Work in progress** (milestone M3 of [PLAN.md](PLAN.md)). The desktop app opens a project folder and shows its dependency graph for TypeScript/JavaScript (tier A, precise resolution) and Python (tier B until its accuracy is measured). Blast radius, risk scores and dead-feature alerts come in later milestones.

Epoch is a local-first desktop app (macOS, Windows, Linux) that turns a codebase into an interactive dependency graph. It scores each file for risk, shows the blast radius of changing any file, and flags likely-dead features (constant branches, stale feature flags, unreachable files) as candidates for review.

## Privacy

Your code never leaves your machine by default, and Epoch never modifies your project.

- **Local-first.** Source code, the graph and the cache stay on your machine. No accounts, no hosted backend, no telemetry.
- **Read-only on projects.** Epoch writes only to its own cache and settings, and to files you explicitly export.
- **Parse, never execute.** Analyzing a repository never runs its code, scripts or config.
- **Model features are opt-in.** Anything that would send data to a model provider is off until you enable it with your own key.

The full rules are in [CLAUDE.md](CLAUDE.md).

## Development

Requirements:

- **Node.js 24.21.0** (the Node bundled in Electron 43.7.7, which the app uses). With [fnm](https://github.com/Schniz/fnm), `fnm use` picks it up from `.node-version`. With nvm-windows, run `nvm install 24.21.0`, then `nvm use 24.21.0`. `pnpm install` fails on unsupported Node versions on purpose.
- **pnpm 11.28.2**: run `npm i -g pnpm@11.28.2`. Inside this repository, `pnpm -v` must print `11.28.2`.

Then:

```sh
pnpm install
pnpm check
```

`pnpm check` runs lint, typecheck and the tests, and works in any shell, including Windows PowerShell 5.1.

### Running the app

Electron 43 has no install script; its binary comes from a separate step, run once:

```sh
pnpm --filter @epoch-dev/app exec install-electron
pnpm dev       # the app with hot reload
pnpm package   # an unpacked, unsigned app in packages/app/release/ (installers come in M8)
pnpm e2e       # Playwright end-to-end and security tests against the built app
```

`pnpm e2e` runs against `pnpm build` output; set `EPOCH_E2E_TARGET=packaged` to test the `pnpm package` output instead. On Linux, run it under `xvfb-run` as a non-root user: the tests keep Chromium's sandbox on, which refuses root. Ubuntu 24.04 also needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` for that sandbox, as CI does.

The headless CLI shares the engine: `node packages/cli/dist/bin.js analyze <folder> [--json]` after `pnpm build`.

| Command               | What it does                                                        |
| --------------------- | ------------------------------------------------------------------- |
| `pnpm build`          | Compile every package (`dist/`, and the app's `out/`)               |
| `pnpm dev`            | Run the desktop app with hot reload                                 |
| `pnpm package`        | Build an unpacked, unsigned app for this OS                         |
| `pnpm e2e`            | Playwright end-to-end and security tests                            |
| `pnpm bench`          | Analysis timings on pinned repositories                             |
| `pnpm bench:accuracy` | TS/JS edge accuracy against dependency-cruiser                      |
| `pnpm typecheck`      | Type-check every package                                            |
| `pnpm lint`           | Prettier check, then ESLint on every package                        |
| `pnpm test`           | Build, then run each package's Vitest suite                         |
| `pnpm check`          | `lint`, `typecheck` and `test` in one command                       |
| `pnpm format`         | Format the repository with Prettier                                 |
| `pnpm telemetry:off`  | Turn off Turborepo telemetry for direct `turbo` use on this machine |

The root scripts already run Turborepo with its telemetry turned off. `pnpm telemetry:off` is only needed if you also run `turbo` directly.

### Windows notes

- If `prettier --check` reports line-ending problems in a file you just created, run `pnpm format`. The repository stores LF everywhere (`.gitattributes`).
- Rename files only with `git mv`. For a change of case only, go through a temporary name: `git mv a.ts tmp.ts`, then `git mv tmp.ts A.ts`.

## Repository layout

```
packages/
  core/                 schemas, interfaces, pure graph algorithms
  adapters/typescript/  TypeScript/JavaScript language adapter (tier A)
  adapters/python/      Python language adapter (tier B)
  findings/             dead-feature detectors and confidence rubric (from M5)
  engine/               analysis pipeline, cache, parse worker pool, git
  cli/                  the headless `epoch` command
  app/                  Electron main process, preload, analysis host, packaging
  ui/                   React + Cytoscape renderer, written against EpochApi
  bench/                pnpm bench and pnpm bench:accuracy
queries/                tree-sitter queries per language
fixtures/               conformance and safety fixtures per language
docs/decisions/         architecture decision records
docs/benchmarks/        generated and measured reports
```

## Documentation

- [CLAUDE.md](CLAUDE.md): what Epoch is, the rules, and the data contracts (source of truth).
- [PLAN.md](PLAN.md): build order, milestones and acceptance criteria.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

[MIT](LICENSE) © 2026 Junhyuk Seo
