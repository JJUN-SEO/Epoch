# ADR-005: Electron, not Tauri, for the desktop shell

- **Status:** Accepted
- **Date:** 2026-10-15
- **Milestone:** M3

## Context

CLAUDE.md ("Tech stack") picks Electron and records the reason: the engine depends on Node (the TypeScript compiler API, native modules, worker threads), which runs as-is in Electron, while Tauri would need a Node sidecar or a Rust rewrite of the engine. PLAN.md asks M3 to confirm that with measured package size, launch time and memory, and to state the case for revisiting Tauri in v2.

## Options and evidence

**Electron 43.7.7** (built in M3)

- **Engine:** runs unchanged. Electron 43.7.7 bundles Node 24.21.0, the version the repository pins (`process.versions`, measured).
  - The analysis host is a `utilityProcess` running the same engine package as the CLI.
  - better-sqlite3's N-API prebuild loads as-is, with no rebuild for Electron's ABI.
  - piscina's worker threads load from inside the asar archive.
  - The packaged e2e test covers all three on Linux, macOS and Windows in CI.
- **UI:** one Chromium (150) on every OS, so Cytoscape's canvas renders the same everywhere, and Playwright drives the real app for the e2e and security tests.
- **Security:** CLAUDE.md "Electron security" is met and tested: context isolation, sandbox, a custom `epoch://` protocol instead of `file://`, a strict CSP, denied navigation, window creation and permissions, and sender-checked, zod-validated IPC. That covers Electron's own checklist except #19 (fuses), which comes with code signing in M8.
- **Cost:** size and memory, measured below.

**Tauri 2** (not built)

- Uses "the system's native webview", which is where its smaller bundles come from (Tauri docs, "What is Tauri?"). That means a different browser engine on each OS for Cytoscape to be tested against.
- The engine would need one of two things:
  - a sidecar, which Tauri supports for "external binaries ... (e.g., Node.js or Python)" through `bundle.externalBin`, one binary per target triple (Tauri docs, "Embedding External Binaries"). That means a Node runtime plus the native and WASM modules per platform, and a third process boundary (Rust core, Node sidecar, webview);
  - or a Rust rewrite of the engine, including TypeScript module resolution, which today is TypeScript's own `resolveModuleName`.
- No Tauri prototype was built for M3, so this ADR quotes no Tauri numbers.

**A local web server with the system browser:** ruled out. CLAUDE.md allows no HTTP server.

## Measurements (Electron)

Packaged with `electron-builder --dir` (unpacked, unsigned), Linux x64, on the host of `docs/benchmarks/typescript-performance.md` (4 × Xeon 2.10 GHz, 16 GiB RAM), under Xvfb with software rendering. macOS and Windows were not timed; CI runs the same packaged e2e tests there but records no timings.

**Size: 397.6 MB unpacked**

| Part                | Size     | Mostly                                                                                                                        |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Electron runtime    | 330.8 MB | the `epoch` binary 224.6 MB, `locales/` 48.1 MB                                                                               |
| `app.asar`          | 49.4 MB  | tree-sitter grammar WASMs for every language 22.0 MB, typescript 20.0 MB, web-tree-sitter 4.6 MB, Epoch's bundled code 2.0 MB |
| `app.asar.unpacked` | 17.3 MB  | better-sqlite3 16.9 MB (prebuilds for eight platforms), @napi-rs/nice 0.4 MB                                                  |

**Time and memory** (three runs each; memory is the sum of every process's working set once the graph is drawn)

| Scenario                                                           | Runs                   | Memory                                                                                               |
| ------------------------------------------------------------------ | ---------------------- | ---------------------------------------------------------------------------------------------------- |
| Launch to the start screen loaded                                  | 381 ms, 368 ms, 441 ms | (n/a)                                                                                                |
| Open Flask 3.1.3 (83 files) to graph drawn, empty cache            | 1.40 s, 1.41 s, 2.10 s | 763–765 MB: browser 164, GPU 150–151, network service 75–76, renderer 209–211, analysis host 163–164 |
| Open vitest (2,451 nodes, worker pool) to graph drawn, empty cache | 4.03 s, 3.46 s, 3.49 s | 878–883 MB: browser 170, GPU 150–151, network service 75, renderer 189, analysis host 294–299        |

About 390 MB of that memory is Chromium's own browser, GPU and network-service processes, which run whatever the app does. The network service runs although Epoch makes no requests.

## Decision

Keep Electron for the MVP. The engine runs unchanged, with the same Node version as the CLI. The UI has one browser engine on every OS. The security requirements are met and tested. Tauri's main gain, size and memory, would shrink once a Node sidecar carries the engine, and it would add per-OS webview testing and another process boundary.

## Consequences

- **Installers are large and the app's baseline memory is high**, as measured above; the README says so (M8).
- **Size work for M8**, each change measured before and after:
  - ship only the grammar WASMs the adapters use (TypeScript, TSX, JavaScript, Python, Go) instead of all of them;
  - ship only the current platform's better-sqlite3 prebuild;
  - leave out TypeScript's `tsc` and `tsserver` entry points (`_tsc.js` alone is 6.2 MB) and its localized messages; resolution needs only `lib/typescript.js` (9.1 MB). electron-builder already drops `.d.ts` files;
  - limit Electron's locales.
- **Fuses (checklist #19) come with signing in M8.** Turning off Node CLI inspect arguments also stops Playwright's Electron launcher, which uses `--inspect`, so the e2e strategy changes then.
- **Revisit Tauri in v2** (CLAUDE.md v2 list): build a Tauri prototype with a Node sidecar, measure it against these numbers, and test the graph on each OS's webview.

## Sources

- Electron 43.7.7 security checklist: https://github.com/electron/electron/blob/v43.7.7/docs/tutorial/security.md (#18 custom protocols, #19 fuses).
- Tauri docs at tauri-apps/tauri-docs commit `32f68c5bfe8b7c42ea5b4d312b533d26521b626c`: `src/content/docs/start/index.mdx` ("What is Tauri?") and `src/content/docs/develop/sidecar.mdx` ("Embedding External Binaries").
- Measurements: `process.versions` inside the packaged app, `du -sb` of `release/linux-unpacked`, and Playwright timing and `app.getAppMetrics()` on the packaged app, run as one-off probes on 2026-10-15.
