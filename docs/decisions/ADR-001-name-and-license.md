# ADR-001: Project name and license

- **Status:** Accepted
- **Date:** 2026-10-14
- **Milestone:** M0
- **Decided by:** Junhyuk Seo (project owner), from options and evidence gathered in the M0 planning session

## Context

CLAUDE.md and PLAN.md were written under the working title "Axon". PLAN.md's pre-M0 questions ask for a final name, checked for collisions on npm, GitHub and the web, and for a license. The name matters beyond branding: it appears in contracts in CLAUDE.md, namely the UI interface (`AxonApi`), the user-written config file (`axon.config.json`), the ignore file (`.axonignore`), the CLI command (`axon …`) and the per-user cache directory name (`env-paths` app name `axon`). Under CLAUDE.md's precedence rule, changing them needs an ADR committed together with the CLAUDE.md change. This ADR is that ADR.

The owner's goals for the license, in their words: a portfolio project they also want to "scale" and "make everyone use", with "some level of intellectual property", and a plan to make it open source.

## Part 1: Name

### Options and evidence

All registry checks were run on 2026-10-14 (`npm view <name>`, `https://registry.npmjs.org/-/org/<scope>/package`, web search). Domain and trademark registries could not be reached from the planning environment, so they are **not verified**.

| Option | Evidence | Assessment |
|---|---|---|
| Axon (keep) | [harshkedia177/axon](https://github.com/harshkedia177/axon) (PyPI `axoniq`) is already a local code-graph tool with dead-code analysis for Python/TS/JS. npm `axon`, `axon-cli` (a coding agent) and `axon-graph` (a data-pipeline visualizer) are taken. The Axon Framework (Java) and Axon Enterprise also use the name. | Direct collision in the same product space |
| Neurite | npm `neurite` is free, but the `@neurite` scope exists. [satellitecomponent/Neurite](https://github.com/satellitecomponent/Neurite) is an MIT, about 2.2k-star, cross-platform desktop graph app ("Fractal Graph-of-Thought … for Ai-Agents, Web-Links, Notes, and Code") that owns neurite.network; no commits since June 2025. PyPI `neurite` and crates.io `neurite` are taken. | High confusion and search risk with a similar desktop graph app |
| codeaxon | npm name and `@codeaxon` scope free; no GitHub repositories; PyPI and crates.io free | Cleanest option on every axis checked |
| axonmap | npm name and scope free; one unrelated 0-star repository | Nearly clean |
| **Epoch** | See below | Chosen |

Evidence for **Epoch**:
- npm `epoch` (0.1.0, 2022) and `epoch-cli` (1.0.2, a Unix-epoch converter) are taken, and **both declare a global bin named `epoch`**. `epochjs` is taken.
- The `@epoch` scope exists (the registry returns `{}`, no public packages). `@epoch-dev` returns "Scope not found", so it was free on 2026-10-14.
- `epoch-graph`, `epoch-code`, `epoch-app`, `epochmap` and `getepoch` are free on npm.
- A web search found no developer tool or dependency-graph tool named Epoch. The word is generic, though: Unix epoch time, machine-learning training epochs, and unrelated projects and organizations such as an Android time app on F-Droid and Epoch AI.

### Decision

The project is named **Epoch**. The CLAUDE.md and PLAN.md identifiers change in the same commit as this ADR:

| Old | New | Kind |
|---|---|---|
| Axon (prose and headings) | Epoch | name |
| `AxonApi` | `EpochApi` | contract (UI interface) |
| `axon.config.json` | `epoch.config.json` | contract (user-written config file) |
| `.axonignore` | `.epochignore` | contract (ignore file) |
| `axon` CLI (`analyze`, `findings`, `cache`, `auth`, `--offline`) | `epoch` | contract (CLI command) |
| `env-paths` app name `axon` | `epoch` | contract (cache location) |
| Repo layout root `axon/` | `epoch/` | documentation |

PLAN.md keeps one deliberate mention of "Axon", in the resolved pre-M0 question 1.

### Consequences

- Internal workspace packages use the free scope `@epoch-dev/*` and stay `"private": true` until M8.
- **The CLI command is `epoch`.** Two existing npm packages also install an `epoch` bin, so a user who has one of them installed globally will see a bin conflict when installing ours globally. This is accepted.
- **Only the npm package name of the published CLI** is left open, for M8 (candidates: `@epoch-dev/cli`, `epoch-code`).
- Search discoverability is weaker than with a distinctive name. The README and site should pair the name with a descriptor, such as "Epoch: code dependency graphs and blast radius".
- Before any public launch (M8), do a manual trademark search (USPTO, EUIPO, WIPO) and check domains. Neither was verifiable during planning.
- The env-paths app name `epoch` is generic and could share a cache directory name with another tool using the same library and name. M2 decides whether the on-disk app id needs a suffix. A suffix change would be an M2 ADR.

## Part 2: License

### Options considered

License texts were read from the SPDX license-list-data repository (list version 3.29.0), apache.org, the PolyForm project's repository (tag 1.0.0) and getsentry/fsl.software. OSI status is taken from SPDX's `isOsiApproved` flag. This is not legal advice.

| License | OSI-approved | Patent grant | Trademark clause | Effect relevant to the goals |
|---|---|---|---|---|
| MIT | yes | none | none | Least friction for adoption. Anyone may fork, repackage or sell, provided the copyright and permission notice are kept. |
| Apache-2.0 | yes | yes (§3) | yes (§6) | Like MIT, plus a patent grant and NOTICE attribution that redistributors must keep (§4(d)). |
| MPL-2.0 | yes | yes (§2.1) | yes (§2.3) | File-level copyleft: modified Epoch files stay open. |
| GPL-3.0 / AGPL-3.0 | yes | yes (§11) | optional (§7(e)) | Forks must stay open. Higher corporate friction (Google's AGPL policy, ASF Category X). AGPL's network clause adds little for a local app. Relicensing later needs a CLA. |
| FSL-1.1 (MIT or ALv2 future) | no | yes | yes | Forbids competing commercial use for two years per version, then each version becomes MIT or Apache-2.0. Cannot be called "open source" until conversion. |
| BUSL-1.1 | no | none in text | yes | "Production" is undefined, which leaves CI use unclear for a developer tool. |
| Elastic-2.0 | no | yes | defers to law | Restricts only hosted services, so it does not protect a desktop app or CLI. |
| PolyForm Shield 1.0.0 | no (and not on the SPDX list) | yes | none | Permanent noncompete; never becomes open source. |

### Decision

**MIT**, with the copyright line "Copyright (c) 2026 Junhyuk Seo".

The owner chose MIT after comparing it with the license of OpenClaw ([LICENSE](https://raw.githubusercontent.com/openclaw/openclaw/main/LICENSE): "MIT License", "Copyright (c) 2026 OpenClaw Foundation"), a widely used open-source project they want Epoch to resemble. MIT puts adoption ("make everyone use it") ahead of restricting what others may do with the code.

### Consequences

- **Copyright stays with the owner.** MIT is a non-exclusive permission, not an assignment ("Permission is hereby granted …"). The "some IP" goal is served by copyright, by owning the project, and by the name, not by the code license.
- **The name is protected separately from the code.** MIT says nothing about trademarks. A trademark policy (and optionally a registration) for "Epoch" can require forks to rebrand. That is a pre-launch task (M8), not an M0 one.
- **Anyone may fork, rebrand and sell Epoch, including as closed source,** as long as they keep the copyright and permission notice. This is accepted.
- **Relicensing.** While the owner is the sole copyright holder, future versions can be released under any license. Versions already released remain available under MIT. MIT's inbound grant includes "sublicense", so outside contributions received under MIT can likely be carried into future versions under other terms with their notices kept (reading of the license text; not verified legally).
- **Contributions.** Outside contributions arrive under the repository license by default (GitHub Terms of Service §D.6). The choice between a DCO (`Signed-off-by`) and a CLA is deferred until the first outside pull request.
- **Dependencies.** All current and planned dependencies are permissive. Checked: electron, web-tree-sitter, better-sqlite3, cytoscape, graphology, chokidar, piscina, simple-git, zod, react, env-paths and ignore are MIT; typescript is Apache-2.0. No copyleft was found in their installed tree. The Electron app and any bundled CLI must ship the third-party notices those licenses require, including TypeScript's Apache-2.0 NOTICE. M3 and M8 verify that in packaged output.
- `LICENSE` and every `package.json` `license` field use the SPDX id `MIT`.

## Sources

- SPDX license list data 3.29.0: https://github.com/spdx/license-list-data (canonical pages under https://spdx.org/licenses/)
- Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0; ASF license categories: https://www.apache.org/legal/resolved.html
- Functional Source License: https://fsl.software/ (source: https://github.com/getsentry/fsl.software)
- Business Source License 1.1: https://mariadb.com/bsl11/
- Elastic License 2.0: https://www.elastic.co/licensing/elastic-license
- PolyForm Shield 1.0.0: https://polyformproject.org/licenses/shield/1.0.0
- Google AGPL policy (read via search summary only): https://opensource.google/docs/using/agpl-policy/
- Developer Certificate of Origin 1.1: https://developercertificate.org/
- GitHub Terms of Service §D.5 and §D.6: https://docs.github.com/en/site-policy/github-terms/github-terms-of-service
- GitHub, licensing a repository: https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository
- npm `license` field: https://docs.npmjs.com/cli/configuring-npm/package-json#license
- OpenClaw license: https://raw.githubusercontent.com/openclaw/openclaw/main/LICENSE
