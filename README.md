# Epoch

> **Work in progress.** This is the M0 scaffold: an empty, fully wired monorepo with no product features yet. See [PLAN.md](PLAN.md) for the build plan.

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

- **Node.js 24.21.0** (the Node bundled in Electron 44). With [fnm](https://github.com/Schniz/fnm), `fnm use` picks it up from `.node-version`. With nvm-windows, run `nvm install 24.21.0`, then `nvm use 24.21.0`. `pnpm install` fails on unsupported Node versions on purpose.
- **pnpm 11.28.2**: run `npm i -g pnpm@11.28.2`. Inside this repository, `pnpm -v` must print `11.28.2`.

Then:

```sh
pnpm install
pnpm check
```

`pnpm check` runs lint, typecheck and the tests, and works in any shell, including Windows PowerShell 5.1.

| Command              | What it does                                                        |
| -------------------- | ------------------------------------------------------------------- |
| `pnpm build`         | Compile every package to `dist/`                                    |
| `pnpm typecheck`     | Type-check every package                                            |
| `pnpm lint`          | Prettier check, then ESLint on every package                        |
| `pnpm test`          | Build, then run each package's Vitest suite                         |
| `pnpm check`         | `lint`, `typecheck` and `test` in one command                       |
| `pnpm format`        | Format the repository with Prettier                                 |
| `pnpm telemetry:off` | Turn off Turborepo telemetry for direct `turbo` use on this machine |

The root scripts already run Turborepo with its telemetry turned off. `pnpm telemetry:off` is only needed if you also run `turbo` directly.

### Windows notes

- If `prettier --check` reports line-ending problems in a file you just created, run `pnpm format`. The repository stores LF everywhere (`.gitattributes`).
- Rename files only with `git mv`. For a change of case only, go through a temporary name: `git mv a.ts tmp.ts`, then `git mv tmp.ts A.ts`.

## Repository layout

```
packages/
  core/                 schemas, interfaces, pure graph algorithms (from M1)
  adapters/typescript/  TypeScript/JavaScript language adapter (from M1)
  findings/             dead-feature detectors and confidence rubric (from M5)
  engine/               analysis pipeline, cache, watcher, git (from M1)
  cli/                  the headless `epoch` command (from M1)
docs/decisions/         architecture decision records
```

## Documentation

- [CLAUDE.md](CLAUDE.md): what Epoch is, the rules, and the data contracts (source of truth).
- [PLAN.md](PLAN.md): build order, milestones and acceptance criteria.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

[MIT](LICENSE) © 2026 Junhyuk Seo
