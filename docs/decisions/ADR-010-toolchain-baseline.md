# ADR-010: Toolchain baseline

- **Status:** Accepted
- **Date:** 2026-10-14
- **Milestone:** M0 (added to the register in M0; numbered after the ADRs PLAN.md already reserves)

## Context

M0 builds an empty monorepo that must pass `pnpm install` then `pnpm check` on macOS, Windows and Linux, locally and in CI. CLAUDE.md fixes the stack in general terms: TypeScript strict, pnpm workspaces + Turborepo, Vitest, ESLint + Prettier, and later Electron. It also says to pin versions and never guess external APIs. Several version and configuration choices turned out to be real decisions with consequences for later milestones, so they are recorded here.

Every version below came from `npm view <pkg> dist-tags time --json` on 2026-10-14. Documentation was read from each project's docs source at the pinned tag, because the planning environment's proxy blocked most doc sites; the canonical URLs are given. Claims marked **verified** were reproduced in a scratch workspace during planning or implementation.

## Decisions

### 1. Node.js 24 line: `.node-version` 24.21.0; engines `^24.0.0 || >=26.0.0`, enforced

- On 2026-10-14 Node 24 ("Krypton") is Active LTS. It enters Maintenance on 2026-10-20 and is supported to 2028-04-30. Node 22 is Maintenance LTS until 2027-04-30.
- Electron 44.7.2, the latest stable Electron, bundles Node v24.21.0 (`node_version` in its `DEPS` file). Pinning dev and CI to the same Node means the CLI and the app's analysis host run on the same runtime.
- The floor **excludes Node 22 on purpose**. The runtime target is Electron's Node 24, and supporting 22 would need its own CI leg. Every pinned tool accepts Node 24 (eslint `^20.19.0 || ^22.13.0 || >=24`, vitest `^22.12.0 || ^24.0.0 || >=26.0.0`, vite `^20.19.0 || >=22.12.0`, pnpm 11 `>=22.13`).
- `engineStrict: true` in `pnpm-workspace.yaml`. **Verified:** without it, pnpm 11.28.2 installs on Node 22 despite the root `engines`; with it, install fails with `ERR_PNPM_UNSUPPORTED_ENGINE`.

### 2. pnpm 11.28.2, not 12.x

- pnpm 12 (npm `latest`, 12.11.2) is a native rewrite first released on 2026-08-26.
- **Verified by a planning reviewer:** with a global pnpm 10 on PATH and `packageManager: pnpm@12.11.2`, pnpm 10 fetches pnpm 12 without running its install script and leaves a placeholder binary. `pnpm -v` looks right, but every `turbo run` task fails with "Exec format error".
- pnpm 11 is plain JavaScript (`bin/pnpm.mjs`) and is still maintained alongside 12 (11.28.5 was published 2026-10-06). **Verified:** a global pnpm 10.28.0 auto-switches to the pinned 11.28.2, and turbo runs package tasks normally.
- Corepack is no longer distributed with Node from v25 ([nodejs/node#57617](https://github.com/nodejs/node/pull/57617)), so the version is pinned with `packageManager`, and contributors install pnpm with `npm i -g pnpm@11.28.2`.
- **Verified** pnpm 11 behaviours the configuration relies on:
  - It reads `allowBuilds`: an unlisted dependency build script fails the install (`ERR_PNPM_IGNORED_BUILDS`), and a listed one passes.
  - It **silently accepts unknown keys** in `pnpm-workspace.yaml`, so a misspelled key gives false confidence. Each key we use is cited to pnpm's docs, and `allowBuilds` and `engineStrict` were proven to work.
- pnpm's default `minimumReleaseAge` (1440 minutes) applies. All pins are older than 24 hours. CI checks that `pnpm install --frozen-lockfile` rewrote no tracked file.
- Revisit pnpm 12 once the auto-switch problem is fixed or contributors' global pnpm is at least 11 (parked).

### 3. Turborepo 2.11.7, with agent guidance, update notices and remote cache off

- 2.11.8 was less than 24 hours old at install time, so the release-age policy would have written exclude entries and failed frozen installs. 2.11.7 avoids that.
- **`agentGuidance: false`.** The 2.11.7 configuration reference bundled in the package says "Default: `true`. When an AI coding agent is detected, `turbo` maintains a managed block in the repository-root `AGENTS.md`". **Verified:** in the planning container, which sets `CLAUDECODE` and `AI_AGENT`, a turbo 2.11.7 run created `AGENTS.md`. That file is not part of the repository layout, and contributors using AI tools would keep getting it.
- `noUpdateNotifier: true`, `remoteCache.enabled: false`.
- Tasks: `build` (after dependencies' builds, output `dist/**`); `typecheck` and `lint` (after dependencies' builds); `test` after the package's own build, so the package contract test can inspect its build output.

### 4. No Turborepo telemetry, without a per-machine step

- Turborepo collects anonymous telemetry by default and honours `TURBO_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1` ([turborepo.dev/docs/telemetry](https://turborepo.dev/docs/telemetry)). There is no `turbo.json` key for it. CLAUDE.md forbids telemetry in the product, and we apply that to our own tooling too.
- The root `build`, `typecheck`, `lint` and `test` scripts run turbo through `scripts/turbo.mjs`. The wrapper sets both variables and starts turbo as `node <turbo/bin/turbo>`:
  - not through the `node_modules/.bin` shim, which on Windows is a `.cmd` file that `child_process` refuses to spawn without a shell;
  - not with `shell: true`, because passing arguments with it is deprecated in Node 24 (DEP0190).
- **Verified:** on a machine whose saved turbo config has `"telemetry_enabled": true`, `node scripts/turbo.mjs telemetry status` reports `Disabled`. CI runs the same check with the workflow-level variables cleared.
- `pnpm telemetry:off` (through the same wrapper, because `turbo telemetry disable` itself records an event while telemetry is on) is the per-machine opt-out for anyone who runs `turbo` directly.
- pnpm's update notifier is off too (`updateNotifier: false`).

### 5. TypeScript 6.0.3, not 7.x

- `typescript@7.0.2` is npm `latest` (2026-07-08) and is the native compiler. Its package root exports only `./lib/version.cjs` plus `./unstable/*`. **Verified** during planning: `import ts from "typescript"` on 7.0.2 exposes `version` and nothing else, so no `resolveModuleName` and no `parseJsonConfigFileContent`. The typescript-go README listed its API as "not ready".
- CLAUDE.md's TS/JS adapter uses the TypeScript compiler API for module resolution (M1). typescript-eslint 8.71.2 requires `typescript >=4.8.4 <6.1.0`.
- So the workspace pins `typescript: 6.0.3` in the pnpm catalog. M1 adds it as a runtime dependency of the adapter, with a guard test that the compiler API exists.
- If tooling moves to TS 7 later, the adapter can keep the TS 6 API through Microsoft's `@typescript/typescript6` package. TS 7 drops options that 6.0 deprecated (`baseUrl`, `node10` and `classic` resolution). That matters because Epoch analyzes third-party repositories that still use them; M1's `baseUrl` conformance case depends on it.
- TS 6 changed two defaults, so the configs set them explicitly: `types: ["node"]` (the default is now `[]`) and per-package `rootDir: "./src"`.

### 6. Compiled internal packages; no project references

- Each package compiles with `tsc` to `dist/`, exposes `exports: {".": {"types": "./dist/index.d.ts", "default": "./dist/index.js"}}` with `types` first, and links siblings with `workspace:*`. Turbo orders work with `^build`.
- Reasons:
  - The CLI and benchmarks run under plain Node.
  - The npm-published CLI must ship JavaScript (M8).
  - Turbo caches `dist/`.
  - Turborepo advises against TypeScript project references ([internal packages](https://turborepo.dev/docs/core-concepts/internal-packages), [TypeScript guide](https://turborepo.dev/docs/guides/tools/typescript)).
- Strictness: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (the last two are not part of `strict`), `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly` (no enums or namespaces), `module: nodenext`.
- Every package's M0 test checks this contract against the real manifest and build output, including that plain Node, not just Vite's more lenient module runner, can load the built entry point.

### 7. Lint and format

- ESLint 10.12.0 with one root flat config, found by each package's `eslint .`.
- typescript-eslint 8.71.2 `strictTypeChecked` and `stylisticTypeChecked` with the project service. `no-explicit-any` is an error.
- `@eslint-community/eslint-plugin-eslint-comments` 4.8.1 `require-description` forces a `-- reason` on every disable directive, which is how "no `any` without a comment explaining why" (CLAUDE.md Conventions) is enforced. ESLint core has no equivalent rule.
- **Network guard:** `no-restricted-imports` (`http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `dns/promises`, each with and without `node:`, plus `undici` and `undici/*`), `no-restricted-globals` (`fetch`, `WebSocket`, `EventSource`) and `no-restricted-properties` (those three on `globalThis` and `global`). This backs CLAUDE.md's rule that all network traffic goes through a single wrapper. Type-only imports are allowed, because they are erased under `verbatimModuleSyntax` and cannot make a call. **Limitation:** it is a backstop, not a proof. It cannot see dynamic `import()`, `require()`, computed property access, or third-party packages that open sockets themselves. M7's zero-network test is the real enforcement, and M7 adds the one allowed exception for the wrapper.
- Prettier 3.9.10, pinned exactly because its docs warn that even patch releases change formatting. `eslint-config-prettier` 10.1.8 comes last. `CLAUDE.md` and `PLAN.md` are excluded from formatting so their wording stays exact.
- `pnpm check` (lint, typecheck, test) gives Windows PowerShell 5.1, which has no `&&`, a single command.

### 8. Vitest 5.0.4, per package

- Each package runs `vitest run --dir src`. Scanning only `src` stops stale `dist/*.test.js` files from running, since Vitest's default exclude is only `node_modules` and `.git`.
- `passWithNoTests` defaults to false, so a package with no tests fails `pnpm test`.
- Vitest resolves the `./x.js` specifiers that nodenext requires to `x.ts` sources (**verified** by a planning reviewer).

### 9. CI on all three OSes from M0

- PLAN.md said "Linux first". The owner develops on macOS and Windows, so the matrix runs ubuntu-24.04, macos-26 (arm64) and windows-2025 from M0. Path-separator, line-ending and shell problems then surface on the first push instead of at M3.
- GitHub-hosted standard runners are free for public repositories (GitHub billing docs).
- Labels are pinned rather than `*-latest`, because `ubuntu-latest` was announced to move to Ubuntu 26.04.
- Actions are pinned by full commit SHA, with the version in a comment, per GitHub's security-hardening guidance: checkout v7.0.1, pnpm/action-setup v6.1.0, setup-node v7.1.0. SHAs were checked with `git ls-remote`.
- `permissions: contents: read`; `persist-credentials: false`; `fail-fast: false`; 20-minute timeout; superseded runs cancelled.
- Every step runs in bash (Git Bash on Windows).
- The job also checks that install rewrote no tracked file, that telemetry reports Disabled with the workflow variables cleared, and that the run left no `AGENTS.md` or other change in the tree.
- **Risk:** pnpm/action-setup v6.1.0 bootstraps pnpm 12.3.4 and then switches to the pinned 11.28.2. That was not tested on Windows before the first run. Fallbacks, in order: `pnpm/setup` v3.1.1 (`a0881977cd8ea73b1ed212236c99ca10dcc80cf4`), then a plain `npm i -g pnpm@11.28.2` step.

### 10. Line endings and editors

- `.gitattributes` sets `* text=auto eol=lf` and marks binaries, so Windows checkouts get LF and Prettier's LF default never conflicts with git's `autocrlf` ([gitattributes](https://git-scm.com/docs/gitattributes#_eol)).
- `.editorconfig` matches (UTF-8, LF, two spaces).
- Case-only renames on macOS and Windows are invisible to git unless made with `git mv`. TypeScript's `forceConsistentCasingInFileNames` and the Linux CI leg catch the rest.

## Consequences

- Contributors need Node 24 and pnpm 11.28.2. Install fails fast with a clear message on the wrong Node, and the README covers fnm and nvm-windows.
- Moving to TS 7 or pnpm 12 is each its own decision, with the triggers above.
- When adding a dependency: say why (CLAUDE.md), check `npm view <pkg> scripts` and any platform-specific optional dependencies. A dependency with an install script must be listed in `allowBuilds`, and one with an install script for a single OS fails only that OS's CI leg. After every install, check that `pnpm-workspace.yaml` is unchanged.
- The network guard and the telemetry wrapper are deliberate guardrails. Removing either needs a new ADR.

## Sources

- Node release schedule: https://github.com/nodejs/Release (schedule.json); https://nodejs.org/en/about/previous-releases
- Electron 44.7.2 DEPS (bundled Node): https://github.com/electron/electron/blob/v44.7.2/DEPS
- Corepack removal: https://github.com/nodejs/node/pull/57617
- pnpm settings (`engineStrict`, `allowBuilds`, `strictDepBuilds`, `minimumReleaseAge`, `updateNotifier`): https://pnpm.io/settings; catalogs: https://pnpm.io/catalogs; workspaces: https://pnpm.io/workspaces
- Turborepo configuration reference (including `agentGuidance`): https://turborepo.dev/docs/reference/configuration; telemetry: https://turborepo.dev/docs/telemetry
- Node DEP0190: https://nodejs.org/api/deprecations.html#DEP0190
- TypeScript 6.0 release notes: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html; tsconfig reference: https://www.typescriptlang.org/tsconfig/
- typescript-go feature table: https://github.com/microsoft/typescript-go
- typescript-eslint typed linting: https://typescript-eslint.io/getting-started/typed-linting/
- eslint-comments `require-description`: https://eslint-community.github.io/eslint-plugin-eslint-comments/rules/require-description.html
- Prettier options (`endOfLine`) and install (exact pinning): https://prettier.io/docs/options, https://prettier.io/docs/install
- Vitest configuration (`dir`, `exclude`, `passWithNoTests`): https://vitest.dev/config/
- GitHub Actions security hardening (SHA pinning): https://docs.github.com/en/actions/reference/security/secure-use
- GitHub runner images: https://github.com/actions/runner-images
