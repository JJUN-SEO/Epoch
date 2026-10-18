# Epoch

> See how a change moves through a codebase. Epoch maps dependencies, shows blast radius and risk tiers, and surfaces likely dead-feature candidates with evidence and caveats.

Epoch is a local-first desktop app for TypeScript/JavaScript, Python and Go. Open a folder to explore its graph; Epoch reads your project but does not change or execute it. The [browser demo](https://jjun-seo.github.io/Epoch/) uses precomputed graphs from public repositories.

![Epoch's shared app UI exploring zod's graph and candidate findings](docs/media/demo.gif)

## Try Epoch

| Platform             | Installer                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| macOS, Apple silicon | [Epoch-mac-arm64.dmg](https://github.com/JJUN-SEO/Epoch/releases/latest/download/Epoch-mac-arm64.dmg)                                                                                                                    |
| Windows, x64         | [Epoch-win-x64-setup.exe](https://github.com/JJUN-SEO/Epoch/releases/latest/download/Epoch-win-x64-setup.exe)                                                                                                            |
| Linux, x64           | [Epoch-linux-x64.deb](https://github.com/JJUN-SEO/Epoch/releases/latest/download/Epoch-linux-x64.deb) or [Epoch-linux-x64.AppImage](https://github.com/JJUN-SEO/Epoch/releases/latest/download/Epoch-linux-x64.AppImage) |

Download links become available when the maintainer publishes a release. The [latest release page](https://github.com/JJUN-SEO/Epoch/releases/latest) includes notes and [SHA256SUMS.txt](https://github.com/JJUN-SEO/Epoch/releases/latest/download/SHA256SUMS.txt). Check the file before opening an installer:

```sh
shasum -a 256 Epoch-mac-arm64.dmg             # macOS
sha256sum Epoch-linux-x64.deb                 # Linux
```

In PowerShell: `Get-FileHash .\Epoch-win-x64-setup.exe -Algorithm SHA256`. Compare the printed hash with the matching line in `SHA256SUMS.txt`.

Early builds are **unsigned**. The macOS app has an ad hoc signature, without Apple notarization; if Gatekeeper blocks it, open Privacy & Security and choose **Open Anyway** after verifying the download. Windows may show SmartScreen; choose **More info → Run anyway** after verifying the hash. The Windows installer is per-user. On Ubuntu 24.04, prefer the `.deb`; the AppImage may need FUSE and a compatible AppArmor configuration. Do not turn off Chromium's sandbox to run it. Signing is deferred until the maintainer chooses how to fund and maintain it.

To use the CLI without an installer, build the repository and run `node packages/cli/dist/bin.js analyze <folder> --json` or `node packages/cli/dist/bin.js findings <folder> --json`. npm publication remains open.

## Explore the demos

- [zod · TypeScript](https://jjun-seo.github.io/Epoch/demo.html?repo=zod) — [source at the pinned commit](https://github.com/colinhacks/zod/tree/680d19f7d1e042e55934209caeb79bc843b94f44), MIT.
- [Flask · Python](https://jjun-seo.github.io/Epoch/demo.html?repo=flask) — [source at the pinned commit](https://github.com/pallets/flask/tree/22d924701a6ae2e4cd01e9a15bbaf3946094af65), BSD-3-Clause.
- [GitHub CLI · Go](https://jjun-seo.github.io/Epoch/demo.html?repo=cli) — [source at the pinned commit](https://github.com/cli/cli/tree/d2535897fd14a9c9697f3c6f112ce34007a6bf95), MIT.

The graphs are the exact output of `epoch --offline analyze <repository> --json` at those commits; [the data script](scripts/site-data.mjs) records the commands, copyright lines and license copies in `apps/site/data/`. The browser demo loads those files only. It cannot read source, dismiss findings, or run a model.

The demo links become live after the first GitHub Pages deployment.

## How it works

Epoch parses files as data, resolves dependency edges, reads local git history for churn and risk, then applies a deterministic findings rubric. It keeps parsed facts in a local cache and updates the graph as files change. The [architecture guide](docs/architecture.md) diagrams the process, network boundary and release flow.

### Privacy and data flow

No account, backend or telemetry is involved. Source and the graph stay on your machine. Remote model features require your own key and consent. Offline mode blocks outbound requests while allowing a local model you chose. The update check asks GitHub Releases for the latest version at most once a day, sends no project data or version, and can be disabled; GitHub still sees the request's IP address, time and `User-Agent: Epoch`. [docs/privacy.md](docs/privacy.md) is the source for this table:

<!-- BEGIN GENERATED:privacy -->

| Feature                                                       | What leaves the machine                                                                                                                                                                                                                                                                                                                                                                                                                                            | Default             | Status today                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parsing, graph, blast radius, risk tiers, git analysis        | Nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                            | On                  | Built                                                                                                                                                                                                                                    |
| Dead-feature detection (reachability, constants, git history) | Nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                            | On                  | Built                                                                                                                                                                                                                                    |
| Heuristic scorer, co-change and shared-string hints           | Nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                            | On                  | Built                                                                                                                                                                                                                                    |
| Embeddings similarity                                         | Nothing (a small local embedding model, all-MiniLM-L6-v2, bundled with the app; chosen in ADR-008)                                                                                                                                                                                                                                                                                                                                                                 | On                  | Built; the app adds similarity after the first graph when its installer carries the model                                                                                                                                                |
| Local-model scorer and summaries (e.g. Ollama)                | Nothing (requests go to the model server on this machine, `http://127.0.0.1:11434`)                                                                                                                                                                                                                                                                                                                                                                                | Opt-in              | Built: the app's summaries (Settings → Summaries, Ollama on this machine; still works in offline mode) and the CLI scorer (`--scorer local`)                                                                                             |
| Jev scorer                                                    | For each scored pair, the start of each file (up to 6,000 characters, at most three files per Go package) and its co-change counts and shared strings, sent to `https://api.typesafe.ai` with your key. TypeSafe's terms say it does not train on what you send, but they set no fixed retention period (zero data retention is for enterprise customers only) and keep a perpetual right to use it for telemetry, abuse monitoring and legal compliance (ADR-017) | Opt-in              | Built: the CLI and benchmark scorer only (`--scorer jev`, with your key from `JEV_API_KEY` or `epoch auth set jev`, `--consent-send` and `--max-spend`); not in the app                                                                  |
| LLM summaries and LLM scorer                                  | The file's source (or a Go package's files) and the summaries of up to eight files it imports; for a folder, its children's summaries. Sent with your key to the provider you choose for summaries: `https://api.anthropic.com`, `https://api.openai.com` or `https://generativelanguage.googleapis.com` (ADR-019); the CLI scorer sends only to Anthropic. With a free-tier Gemini key, Google may use what is sent to improve its products                       | Opt-in              | Built: the app's summaries, after you add your key (which turns them on) and give a one-time consent per project in a dialog that lists what is sent; the CLI scorer (`--scorer llm`, with your key, `--consent-send` and `--max-spend`) |
| Update check                                                  | At most once a day, one GET to `https://api.github.com/repos/JJUN-SEO/Epoch/releases/latest` for the latest version number. No project data, no version and no identifier: GitHub sees your IP address, the time and fixed headers (user agent "Epoch")                                                                                                                                                                                                            | On; can be disabled | Built: a notice in the window links to the release page, and you download and install the new version yourself; nothing is downloaded or run automatically (ADR-018). Offline mode forces it off                                         |

<!-- END GENERATED:privacy -->

### Findings are candidates

Epoch looks for constant branches, possibly stale flags and possibly unused files. Each finding lists caveats before evidence, a confidence level and a suggested next step. Dynamic imports, framework conventions, tooling and languages outside the analyzed set can hide real uses. Epoch never changes the project. See [the rubric and configuration guide](docs/findings.md).

The reviewed sample below was assessed by Claude at the maintainer's request; it is **not** a human precision study. It covers pinned repositories and should not be read as a guarantee on a new codebase. Copied from [the findings report](docs/benchmarks/findings.md):

<!-- BEGIN GENERATED:findings-precision -->

| Confidence   | Yes | No  | Unsure | Not reviewed | Precision |
| ------------ | --- | --- | ------ | ------------ | --------- |
| Worth a look | 11  | 0   | 0      | 0            | 100.0%    |
| Maybe        | 8   | 31  | 0      | 0            | 20.5%     |

<!-- END GENERATED:findings-precision -->

## Measured results

Every table below is copied by `scripts/readme-tables.mjs` from a report generated by a reproducible script. `pnpm lint` fails if a copied cell is edited. Each linked report names its repositories, commits, method, host and limits.

### Full and incremental analysis

zod, from [the performance report](docs/benchmarks/typescript-performance.md). The report also covers vitest; these timings are medians under the report's stated conditions.

<!-- BEGIN GENERATED:typescript-performance -->

| Scenario                     | Wall   | Analysis | Discover | Changes | Parse  | Resolve | Graph | Files parsed | Files re-hashed |
| ---------------------------- | ------ | -------- | -------- | ------- | ------ | ------- | ----- | ------------ | --------------- |
| cold (empty cache)           | 1.69 s | 1.18 s   | 27 ms    | 42 ms   | 850 ms | 234 ms  | 26 ms | 522          | 522             |
| cold, parsing in-process     | 2.11 s | 1.61 s   | 27 ms    | 39 ms   | 1.32 s | 200 ms  | 23 ms | 522          | 522             |
| warm, unchanged              | 809 ms | 319 ms   | 30 ms    | 66 ms   | 0 ms   | 199 ms  | 25 ms | 0            | 0               |
| incremental, 1 file edited   | 890 ms | 375 ms   | 34 ms    | 64 ms   | 52 ms  | 201 ms  | 25 ms | 1            | 3               |
| incremental, 5 files edited  | 898 ms | 406 ms   | 26 ms    | 62 ms   | 91 ms  | 201 ms  | 26 ms | 5            | 15              |
| incremental, 50 files edited | 1.13 s | 590 ms   | 26 ms    | 78 ms   | 230 ms | 230 ms  | 33 ms | 50           | 135             |

<!-- END GENERATED:typescript-performance -->

### Dependency accuracy

TypeScript/JavaScript versus dependency-cruiser, from [the TS/JS report](docs/benchmarks/typescript.md). Adjusted scores classify each disagreement and include real edges the comparison tool missed.

<!-- BEGIN GENERATED:typescript-accuracy -->

| Repository                               | Commit       | Files | Epoch edges | Tool edges | Agreed | Raw precision | Raw recall | Adjusted precision | Adjusted recall | Unclassified |
| ---------------------------------------- | ------------ | ----- | ----------- | ---------- | ------ | ------------- | ---------- | ------------------ | --------------- | ------------ |
| https://github.com/colinhacks/zod.git    | 680d19f7d1e0 | 522   | 965         | 643        | 643    | 66.6%         | 100.0%     | 100.0%             | 100.0%          | 0            |
| https://github.com/vitest-dev/vitest.git | 2899eb3e9793 | 2400  | 4632        | 2577       | 2556   | 55.2%         | 99.2%      | 100.0%             | 100.0%          | 0            |

<!-- END GENERATED:typescript-accuracy -->

Python versus grimp, from [the Python report](docs/benchmarks/python-accuracy.md). The adjusted score accounts for namespace package imports the comparison tool missed.

<!-- BEGIN GENERATED:python-accuracy -->

| Edges          | Epoch | grimp | Agreed | Raw precision | Raw recall | Adjusted precision | Adjusted recall | Unclassified |
| -------------- | ----- | ----- | ------ | ------------- | ---------- | ------------------ | --------------- | ------------ |
| Module imports | 95    | 68    | 68     | 71.6%         | 100.0%     | 100.0%             | 100.0%          | 0            |

<!-- END GENERATED:python-accuracy -->

Go versus `go list`, from [the Go report](docs/benchmarks/go.md). Build-tagged test files explain the remaining test-edge difference.

<!-- BEGIN GENERATED:go-accuracy -->

| Edges      | Epoch | go list | Agreed | Precision | Recall |
| ---------- | ----- | ------- | ------ | --------- | ------ |
| Production | 1444  | 1444    | 1444   | 100.0%    | 100.0% |
| Tests      | 1098  | 1093    | 1093   | 99.5%     | 100.0% |

<!-- END GENERATED:go-accuracy -->

### Risk and hint scoring

The risk tiers were evaluated against files fixed in a later window; hindsight is a proxy, not proof of a defect. From [the risk report](docs/benchmarks/risk.md):

<!-- BEGIN GENERATED:risk -->

| Tier         | All repositories   | zod             | vitest              | flask-full     | cli-full          |
| ------------ | ------------------ | --------------- | ------------------- | -------------- | ----------------- |
| critical     | 81.4% (48 of 59)   | 75.0% (6 of 8)  | 97.1% (33 of 34)    | 33.3% (1 of 3) | 57.1% (8 of 14)   |
| high         | 50.0% (46 of 92)   | 20.0% (1 of 5)  | 66.0% (33 of 50)    | 0.0% (0 of 3)  | 35.3% (12 of 34)  |
| moderate     | 33.1% (119 of 360) | 18.0% (9 of 50) | 42.8% (92 of 215)   | 9.1% (1 of 11) | 20.2% (17 of 84)  |
| low-moderate | 11.9% (44 of 371)  | 1.6% (1 of 61)  | 17.0% (24 of 141)   | 0.0% (0 of 9)  | 11.9% (19 of 160) |
| low          | 9.5% (197 of 2081) | 3.6% (9 of 247) | 10.5% (162 of 1540) | 0.0% (0 of 57) | 11.0% (26 of 237) |

<!-- END GENERATED:risk -->

Hint scorer calibration on a temporal holdout, from [the scorer report](docs/benchmarks/scorers.md). Hints never become fact edges or findings.

<!-- BEGIN GENERATED:scorers -->

| Scorer                                                                               | Judged | Positive rate | Mean p | Brier | ECE   | ROC AUC |
| ------------------------------------------------------------------------------------ | ------ | ------------- | ------ | ----- | ----- | ------- |
| Heuristic with a model, fitted on T0                                                 | 15472  | 18.0%         | 0.163  | 0.126 | 0.027 | 0.707   |
| Heuristic with a model, shipped coefficients                                         | 15472  | 18.0%         | 0.163  | 0.126 | 0.027 | 0.707   |
| Heuristic without a model, fitted on T0 (similarity-only pairs at 0: never proposed) | 15472  | 18.0%         | 0.076  | 0.139 | 0.113 | 0.659   |
| Cosine alone                                                                         | 15472  | 18.0%         | 0.708  | 0.464 | 0.566 | 0.501   |
| Co-change ratio alone                                                                | 15472  | 18.0%         | 0.044  | 0.149 | 0.141 | 0.638   |
| Constant (T0 positive rate)                                                          | 15472  | 18.0%         | 0.195  | 0.148 | 0.015 | 0.500   |

<!-- END GENERATED:scorers -->

### Summary cost

Measured with one provider, one pinned Flask history and the report's stated price; your cost depends on your provider, model and changes. From [the summary report](docs/benchmarks/summaries.md):

<!-- BEGIN GENERATED:summary-cost -->

| Run                                         | Requests | Stored | Not stored (refusal, cut off, emptied) | Input tokens | Output tokens | Cost    | Time in requests | Stopped early |
| ------------------------------------------- | -------- | ------ | -------------------------------------- | ------------ | ------------- | ------- | ---------------- | ------------- |
| Full run                                    | 108      | 108    | 0                                      | 269203       | 16255         | $0.035  | 144.5 s          | no            |
| Incremental run, whole project              | 102      | 102    | 0                                      | 269860       | 15408         | $0.035  | 136.9 s          | no            |
| Incremental run, new and changed files only | 7        | 7      | 0                                      | 56897        | 1250          | $0.0063 | 11.1 s           | –             |

<!-- END GENERATED:summary-cost -->

### Installer sizes

These are from the [installer size report](docs/benchmarks/installers.md), generated by `scripts/package-size.mjs` on the CI run named there. They describe that run's build, not a promise about later releases.

<!-- BEGIN GENERATED:installers -->

| Runner       | Installer                  | Size     |
| ------------ | -------------------------- | -------- |
| macos-26     | `Epoch-mac-arm64.dmg`      | 210.3 MB |
| windows-2025 | `Epoch-win-x64-setup.exe`  | 200.1 MB |
| ubuntu-24.04 | `Epoch-linux-x64.AppImage` | 223.3 MB |
| ubuntu-24.04 | `Epoch-linux-x64.deb`      | 192.5 MB |

<!-- END GENERATED:installers -->

## Tradeoffs and limits

Electron carries a full runtime and a local embedding model, which makes installers larger. It lets the same Node-based analysis engine run in the desktop app and CLI. The installer size report breaks down that cost. Resolver-proven edges are distinct from heuristic hints; unsupported dynamic behavior remains a limit. The static demo cannot represent private code or try model features. The app's notice checks for an update but never downloads or installs one.

## Releasing

`packages/app/package.json` is the version source. A matching `v<version>` tag builds and smoke-tests installers on macOS, Windows and Ubuntu runners, then creates a **draft** GitHub Release with all four installers and checksums. The maintainer checks the draft and publishes it. The site deploys from GitHub Actions when Pages uses **GitHub Actions** as its source. See [ADR-018](docs/decisions/ADR-018-distribution.md) for the distribution choices.

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
pnpm dev           # the app with hot reload
pnpm package       # this OS's installers in packages/app/release/ (unsigned)
pnpm package:dir   # the unpacked app the e2e tests drive
pnpm e2e           # Playwright end-to-end and security tests against the built app
```

`pnpm e2e` runs against `pnpm build` output; set `EPOCH_E2E_TARGET=packaged` to test the `pnpm package:dir` output instead (the installers' fuses, except that Playwright needs Node's inspector; ADR-018). On Linux, run it under `xvfb-run` as a non-root user: the tests keep Chromium's sandbox on, which refuses root. Ubuntu 24.04 also needs `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` for that sandbox, as CI does.

The headless CLI shares the engine: `node packages/cli/dist/bin.js analyze <folder> [--json] [--coverage <report>]` after `pnpm build`.

Similarity hints need the local embedding model, which is not in the repository. `node scripts/fetch-model.mjs` downloads the pinned default into `models/` (checked against its sha256; behind a proxy, set `NODE_USE_ENV_PROXY=1`). `pnpm dev` and `pnpm package` then use it, and the CLI takes `--embedding-model models/<id>`. Without it, everything else works and similarity is off.

| Command                      | What it does                                                        |
| ---------------------------- | ------------------------------------------------------------------- |
| `pnpm build`                 | Compile every package (`dist/`, and the app's `out/`)               |
| `pnpm dev`                   | Run the desktop app with hot reload                                 |
| `pnpm package`               | Build this OS's installers (unsigned)                               |
| `pnpm package:dir`           | Build the unpacked app the packaged e2e tests drive                 |
| `pnpm e2e`                   | Playwright end-to-end and security tests                            |
| `pnpm bench`                 | Analysis timings on pinned repositories                             |
| `pnpm bench:accuracy`        | TS/JS edge accuracy against dependency-cruiser                      |
| `pnpm bench:accuracy-python` | Python edge accuracy against grimp (needs a virtualenv)             |
| `pnpm bench:accuracy-go`     | Go edge accuracy against `go list` (needs a Go toolchain)           |
| `pnpm bench:watch`           | Watcher latency and churn cost                                      |
| `pnpm bench:scorers`         | Hint scorers on a temporal holdout (`--embedding-model <dir>`)      |
| `pnpm typecheck`             | Type-check every package                                            |
| `pnpm lint`                  | Prettier check, then ESLint on every package                        |
| `pnpm test`                  | Build, then run each package's Vitest suite                         |
| `pnpm check`                 | `lint`, `typecheck` and `test` in one command                       |
| `pnpm format`                | Format the repository with Prettier                                 |
| `pnpm telemetry:off`         | Turn off Turborepo telemetry for direct `turbo` use on this machine |

The root scripts already run Turborepo with its telemetry turned off. `pnpm telemetry:off` is only needed if you also run `turbo` directly.

### Windows notes

- If `prettier --check` reports line-ending problems in a file you just created, run `pnpm format`. The repository stores LF everywhere (`.gitattributes`).
- Rename files only with `git mv`. For a change of case only, go through a temporary name: `git mv a.ts tmp.ts`, then `git mv tmp.ts A.ts`.

## Repository layout

```
packages/
  core/                 schemas, interfaces, pure graph algorithms
  adapters/typescript/  TypeScript/JavaScript language adapter (tier A)
  adapters/python/      Python language adapter (tier A)
  adapters/go/          Go language adapter, packages as nodes (tier A)
  findings/             dead-feature detectors and confidence rubric (from M5)
  engine/               analysis pipeline, cache, parse worker pool, git churn, coverage, watcher
  cli/                  the headless `epoch` command
  app/                  Electron main process, preload, analysis host, packaging
  ui/                   React + Cytoscape renderer, written against EpochApi
  bench/                pnpm bench and the accuracy and watcher benchmarks
queries/                tree-sitter queries per language
fixtures/               conformance and safety fixtures per language
docs/decisions/         architecture decision records
docs/benchmarks/        generated and measured reports
```

## Documentation

- [CLAUDE.md](CLAUDE.md): what Epoch is, the rules, and the data contracts (source of truth).
- [PLAN.md](PLAN.md): build order, milestones and acceptance criteria.
- [docs/findings.md](docs/findings.md): finding kinds, rubric, configuration and limits.
- [docs/decisions/](docs/decisions/): architecture decision records.

## License

[MIT](LICENSE) © 2026 Junhyuk Seo
