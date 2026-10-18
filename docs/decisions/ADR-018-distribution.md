# ADR-018: Distribution: installers, fuses, release, update check

- **Status:** Proposed (fuses built 2026-10-18; installers, release workflow and update check follow in M8)
- **Date:** 2026-10-18
- **Milestone:** M8

## Context

CLAUDE.md ("Distribution") asks for installers for macOS, Windows and Linux built by CI on one runner per OS and published on GitHub Releases, unsigned early builds with documented first-run steps, and a static site. ADR-005 left two things for M8: the size work, and Electron's fuses, which it tied to M8 because turning off Node's inspector also stops Playwright's Electron launcher.

This ADR records how Epoch is packaged and released. It grows as M8 lands: fuses first, then installers, the release workflow and the update check.

## Sources

- Electron's fuses, as electron-builder 26.17.0 documents them (`app-builder-lib/out/configuration.d.ts`, `FuseOptionsV1`, which quotes Electron's fuse docs) and as `@electron/fuses` 1.8.0 reads them (`dist/config.d.ts`: the option indexes; `dist/constants.d.ts`: a fuse is the byte `1` or `0`).
- Playwright's Electron launcher, playwright-core 1.63.0 (`lib/coreBundle.js`): it always starts the app with `--inspect=0 --remote-debugging-port=0`.
- electron-builder's config merge, app-builder-lib 26.17.0 (`out/util/config/config.js`): `extends` configs are combined with `deepAssign`.

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

**Found by that spike.** The network log of the run held one request: Chromium's spellchecker downloading a dictionary from Google when the window opened. It bypassed the default session's request filter and broke CLAUDE.md's "no keys, no requests". Epoch now turns the spellchecker off (`harden.ts`), and `no-network.spec.ts` records the log from launch to quit.

## Consequences

- Shipped builds refuse `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`, and load only the validated `app.asar`.
- The e2e suite runs against a build that differs from the installers in one fuse. The installer smoke test covers the shipped fuses.
- Asar integrity on macOS depends on electron-builder signing (ad hoc) after it flips the fuses; the packaged e2e suite on macOS and Windows shows the app still starts.
