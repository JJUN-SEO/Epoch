# ADR-018: Distribution: installers, fuses, release, update check

- **Status:** Proposed (implementation and installer smoke tests pass; tagged draft and maintainer publication pending)
- **Date:** 2026-10-18
- **Milestone:** M8

## Context

CLAUDE.md ("Distribution") asks for installers for macOS, Windows and Linux built by CI on one runner per OS and published on GitHub Releases, unsigned early builds with documented first-run steps, and a static site. ADR-005 left two things for M8: the size work, and Electron's fuses, which it tied to M8 because turning off Node's inspector also stops Playwright's Electron launcher.

This ADR records how Epoch is packaged and released. It grew through M8: fuses, installers, the release workflow and the update check. The release workflow still needs its first version tag and maintainer review before this ADR is accepted.

## Sources

- Electron's fuses, as electron-builder 26.17.0 documents them (`app-builder-lib/out/configuration.d.ts`, `FuseOptionsV1`, which quotes Electron's fuse docs) and as `@electron/fuses` 1.8.0 reads them (`dist/config.d.ts`: the option indexes; `dist/constants.d.ts`: a fuse is the byte `1` or `0`).
- Playwright's Electron launcher, playwright-core 1.63.0 (`lib/coreBundle.js`): it always starts the app with `--inspect=0 --remote-debugging-port=0`.
- electron-builder's config merge, app-builder-lib 26.17.0 (`out/util/config/config.js`): `extends` configs are combined with `deepAssign`.
- GitHub's REST API docs, read 2026-10-18: "Get the latest release" (docs.github.com/en/rest/releases/releases: "the most recent non-prerelease, non-draft release"; works without authentication for public repositories; `Accept: application/vnd.github+json` recommended); "API Versions" (current version `2026-03-10`); "Rate limits for the REST API" (60 unauthenticated requests per hour, counted per IP address); "Getting started with the REST API" ("All API requests must include a valid User-Agent header").

## Decision

### 1. Size (ADR-005's list, measured)

`scripts/package-size.mjs` measures an unpacked app by part. On Linux x64 the trims took it from 537.4 MB to 442.9 MB: only this platform's better-sqlite3 prebuild, only the five grammars the adapters load, TypeScript without its compiler and language server, no source maps or debug builds, English locales only. The numbers per part are in the commit that made the change (`build(app): ship only what runs`); `packaged.spec.ts` checks each trim on every OS.

WASM stays inside `app.asar`: it is read with `fs`, which reads the archive, so PLAN.md's "`asarUnpack` for … WASM" is not needed. Native addons and the ONNX runtime are unpacked, as before.

### 2. Fuses

Fuses are switches in the Electron binary, flipped by electron-builder when it packages (`electronFuses` in `packages/app/electron-builder.yml`).

| Fuse                                    | Installers | e2e build (CI only) | Why                                                                                                                                                                                                                       |
| --------------------------------------- | ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runAsNode`                             | off        | off                 | Nothing uses `ELECTRON_RUN_AS_NODE`: the analysis host is a `utilityProcess` and parsing runs in worker threads. Left on, any local process could run its own JavaScript as Epoch, with Epoch's keychain access on macOS. |
| `enableNodeOptionsEnvironmentVariable`  | off        | off                 | Main never uses Node's networking (the tripwire, ADR-016), so `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` would only let the environment change Node.                                                                        |
| `enableNodeCliInspectArguments`         | **off**    | on                  | `--inspect` would let anything on the machine attach a debugger to main, where keys are decrypted. Playwright needs it, so only the e2e build has it.                                                                     |
| `enableEmbeddedAsarIntegrityValidation` | on         | on                  | Validates `app.asar` when it is loaded (macOS, and Windows with Electron 30 or later).                                                                                                                                    |
| `onlyLoadAppFromAsar`                   | on         | on                  | With the integrity check, no code outside the validated archive can load.                                                                                                                                                 |
| `grantFileProtocolExtraPrivileges`      | off        | off                 | The UI is served from `epoch://` (ADR-005), never `file://`.                                                                                                                                                              |
| `enableCookieEncryption`                | off        | off                 | Epoch stores no cookies. Turning it on makes Chromium read the OS keychain at startup, which on ad-hoc-signed macOS builds can prompt again after every update.                                                           |

**The e2e build.** `electron-builder.e2e.yml` extends `electron-builder.yml` and turns only the inspector fuse back on; `pnpm --filter @epoch-dev/app package:dir` uses it, in CI and locally. It is never uploaded. `src/packaging.test.ts` checks that the two configs differ in that one fuse, and `packaged.spec.ts` reads the fuse wire of the built executable.

**Testing installers without the inspector (spike, 2026-10-18).** A Linux package with the installer fuses was started with `--remote-debugging-port=0`, a Chromium switch the fuse does not affect, and driven with Playwright's `chromium.connectOverCDP`: it opened a project from a seeded recent list, showed the graph, and `--inspect` was refused (no debugger started). On SIGTERM it quit cleanly with exit code 0, so Chromium's network log (`--log-net-log`) was complete. The installer smoke test (M8) works this way, so installers ship with the inspector off.

**Found by that spike and the smoke test.** The network log of the run held one request: Chromium's spellchecker downloading a dictionary from Google when the window opened. It bypassed the default session's request filter and broke CLAUDE.md's "no keys, no requests". Epoch now turns the spellchecker off (`harden.ts`), and `no-network.spec.ts` records the log from launch to quit. The smoke test then found the same download when the first summary (here from a local model) opened main's egress session; that session turns it off too (`egress.ts`), and `offline.spec.ts` now also checks its whole run's log, from launch.

### 3. Update check, not auto-update

CLAUDE.md asked for auto-update via the release host (for example `electron-updater`), opt-out. The maintainer chose check-and-notify instead, and CLAUDE.md's Architecture and Distribution sections now say so (this commit).

| Option               | Why not, or why                                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron-updater`   | Downloads and runs new code by itself. On macOS, Squirrel.Mac only installs updates to a signed app, and Epoch is unsigned (decision 4, signing status), so it would not work there at all. Its metadata files and blockmaps would also have to be published and trusted. |
| Nothing              | Users of unsigned builds would never learn that a fix exists.                                                                                                                                                                                                             |
| **Check and notify** | One small request; nothing downloaded or run. The user reads the release and installs it the way they installed Epoch.                                                                                                                                                    |

How it works (`src/main/update-check.ts`, `update-store.ts`, `egress.ts`):

- At most once a day (and again if the clock went back), main sends one GET to `https://api.github.com/repos/JJUN-SEO/Epoch/releases/latest`. The first check runs 10 s after the window opens, then an hourly tick asks only when the last answer is a day old. The answer and the time are kept in `update-check.json` in Epoch's own data directory.
- **Never** with update checks off or offline mode on (`updateChecksAllowed`, read at each use). Turning either off aborts a request in flight.
- **What is sent:** fixed headers only (`Accept`, `X-GitHub-Api-Version: 2026-03-10`, `User-Agent: Epoch`, `Accept-Language: en`, plus Chromium's fixed `Sec-Fetch-*` and `Accept-Encoding`). No version, no identifier, no cookies (`credentials: "omit"`), no redirects (`redirect: "error"`: the old repository name answers with a redirect). A spike on Electron 43's `session.fetch` confirmed the custom `User-Agent` and `Accept-Language` hold, no cookie is sent back, and a redirect is refused.
- **What is kept:** only `tag_name`, read from at most 1 MB, and only when it is a plain `vMAJOR.MINOR.PATCH` (pre-releases are ignored). Main compares it with `app.getVersion()`; when it is newer, the window gets a notice whose link is built from a constant (`releasePageUrl`), never taken from the answer, and opens in the browser through the external-link allowlist.
- **Two layers allow it:** a network wrapper of its own (`createNet` with only `https://api.github.com`, refused offline), and main's egress session, whose filter allows exactly that URL, by GET, online. Summaries and the update check share the one egress session, because a session takes one request filter.
- **Failures are silent:** a non-200 answer, bad JSON, a redirect or an unreachable host shows nothing and waits a day. Users behind one address share GitHub's 60 requests per hour; a refused check just waits for the next day.
- **Tests:** unit tests for the checker (fake clock and fetch), the store, version parsing and the egress filter; `e2e/launch.ts` starts every e2e run with update checks off, so no test contacts GitHub; the installer smoke test runs with checks off, then with offline mode on and checks on, and sees no request.

## Consequences

- Shipped builds refuse `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and load only the validated `app.asar`.
- The e2e suite runs against a build that differs from the installers in one fuse. The installer smoke test covers the shipped fuses.
- Asar integrity on macOS depends on electron-builder signing (ad hoc) after it flips the fuses; the packaged e2e suite on macOS and Windows shows the app still starts.
- Epoch makes one network request that no user action starts: the daily update check, opt-out in Settings and off in offline mode. The first-run screen and Settings say so.

### 4. Installers, release, and signing

`electron-builder.yml` produces an Apple silicon DMG, a per-user Windows NSIS installer, and Linux AppImage and deb packages. `packages/app/package.json` is the version source. A `v<version>` tag runs the version check, then the matrix builds and smoke-tests each installer on a fresh runner of its own OS. Only after every smoke leg passes does the workflow create a **draft** GitHub Release with the four installers and `SHA256SUMS.txt`. The maintainer publishes it after review. The site uses version-free artifact names in `releases/latest/download/...`, so the links do not change for the next release.

The [installer size report](../benchmarks/installers.md) is generated from the successful [CI run 39096906655](https://github.com/JJUN-SEO/Epoch/actions/runs/39096906655) at commit `76375cfdafdf604e5d3afc8383c4bc921e0fa20f`. It includes component breakdowns and all four package sizes, measured on their native OS runners. It supersedes the earlier Linux size quoted in decision 1 for the later build; no benchmark number was estimated for the README.

Early releases are unsigned. macOS uses only an ad hoc signature for Apple silicon, with no Developer ID certificate or notarization. Windows has no code-signing certificate. Linux packages are unsigned. The README and release notes give checksum verification and first-run steps. No signing purchase or credential is assumed.

**Signing status (maintainer decision, 2026-10-22):** stay unsigned. Each user clicks through one first-run warning (Gatekeeper's "Open Anyway", SmartScreen's "Run anyway"), which the README, the landing page and the release notes explain, with checksums to verify the download. Signing would need a paid Apple Developer membership with notarization, and a Windows code-signing certificate or signing service. Revisit before a launch to a wider, non-technical audience; the release workflow would then take the credentials as secrets, and `electron-updater` (decision 3) could be reconsidered for macOS.
