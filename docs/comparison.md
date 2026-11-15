# Epoch next to GitNexus and Graphify

People ask how Epoch differs from two popular code-graph tools. This page answers from each project's own documentation, read on the dates below. It is not a ranking: the three answer different questions, and for some jobs one of the others is the better choice.

- **GitNexus:** [README](https://github.com/abhigyanpatwari/GitNexus) with its MCP and CLI references, read 2026-10-28.
- **Graphify:** [README](https://github.com/safishamsi/graphify), read 2026-11-15.
- **Epoch:** this repository at the commit you are reading.

Neither tool was run for this page. "Not described" means the pages read do not mention it, not that the tool cannot do it. Both projects move fast, so check their documentation, and open an issue here if something is out of date.

## In one line each

- **GitNexus** indexes a codebase into a knowledge graph of symbols, calls and execution flows, mainly for AI coding agents to query.
- **Graphify** turns a folder (code, documents, PDFs, images, video) into a knowledge graph an AI assistant queries instead of re-reading files.
- **Epoch** shows a person, a pull request or an agent what depends on a file, how risky it is to change, and which code is likely unused, with measured accuracy and without touching the project.

## Side by side

|                                 | Epoch                                                                                                                     | GitNexus                                                                                                              | Graphify                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Unit of the graph               | Files (Go: packages) and their imports                                                                                    | Symbols: functions, classes, calls, execution flows                                                                   | Symbols and concepts: calls, imports, inheritance; also documents and media                       |
| Languages                       | TypeScript/JavaScript, Python, Go, each measured against a reference tool                                                 | 18 "registered providers"; "support varies by construct"                                                              | "~40 languages" by tree-sitter                                                                    |
| Published accuracy of the graph | Edge precision and recall per language, with method and limits ([results](results.md))                                    | Language inventories of "measured behavior, exclusions and remaining gaps"                                            | Benchmarks of memory retrieval and question answering, and a code-intelligence result             |
| Main way to use it              | Desktop app; also a CLI and a browser demo                                                                                | A coding agent's MCP tools; also a CLI and a web UI                                                                   | A command inside an AI assistant; also a CLI and an HTML graph                                    |
| AI agent access                 | `epoch mcp`: 8 read-only tools over stdio ([agents.md](agents.md))                                                        | 19 MCP tools, over stdio or HTTP                                                                                      | Assistant skill and hooks for 25+ assistants; an MCP server                                       |
| What changing a file affects    | Blast radius, in the app, CLI and agent tools                                                                             | `impact`                                                                                                              | `query`, `path`, `explain` over the graph                                                         |
| What a pull request touches     | `epoch impact --base`, with each changed file's risk tier; can fail a CI job                                              | `detect_changes`; PR review is listed under its enterprise offering                                                   | `graphify prs`                                                                                    |
| Path between two things         | Shortest chain of imports between two files                                                                               | `trace`, between two symbols                                                                                          | `path`, between two nodes                                                                         |
| Clusters                        | Files that depend mostly on each other, as a color mode                                                                   | Functional clusters                                                                                                   | Communities, with labels                                                                          |
| Risk of touching a file         | A tier from dependents, commits in the last 90 days, and size or test coverage; checked against later fix commits         | A risk level for a diff; history and coverage not described                                                           | Not described                                                                                     |
| Test coverage                   | Reads lcov, Cobertura, Clover, Istanbul JSON and Go profiles                                                              | Not described                                                                                                         | Not described                                                                                     |
| Likely-unused code              | Candidates with evidence, caveats and a confidence level: branches that never run, stale feature flags, unreachable files | Not described                                                                                                         | Not described                                                                                     |
| Rename, data-flow and taint     | No                                                                                                                        | Semantic `rename`; statement-level dependence and taint findings                                                      | Not described                                                                                     |
| Documents, PDFs, images, video  | No                                                                                                                        | No                                                                                                                    | Yes, through a model you configure                                                                |
| Writes into your project        | Never                                                                                                                     | By default `analyze` installs agent skills, registers hooks, writes `AGENTS.md`/`CLAUDE.md`, and keeps `.gitnexus/`   | Writes `graphify-out/`; `install` writes assistant configuration or hooks                         |
| Network                         | No HTTP server. Nothing leaves the machine unless you add a model key; offline mode is tested to make no request          | Indexes locally without a model; a local HTTP server feeds a hosted web UI; optional remote embeddings, wiki and chat | Code is parsed locally; documents and media go to the model backend you configure; "No telemetry" |
| License                         | MIT                                                                                                                       | PolyForm Noncommercial; commercial licenses and an enterprise offering                                                | Apache-2.0; a hosted cloud product                                                                |

## When to pick which

- **You want an agent to navigate a large codebase at the level of functions and call chains, in many languages:** GitNexus or Graphify. Epoch's graph is files and imports, in three languages.
- **You want one graph over code, design documents, papers and screenshots:** Graphify.
- **You want to know which files are risky to touch and why, what a pull request reaches, or which code is likely unused, with numbers you can check:** Epoch.
- **You can't have a tool write into the repository, or run a local server:** Epoch.
- **You need a permissive license for commercial use:** Epoch (MIT) or Graphify (Apache-2.0).

## What Epoch does not try to do

Matching either tool's breadth is not a goal ([CLAUDE.md](../CLAUDE.md), non-goals). Epoch has no symbol-level call graph, no rename, no taint analysis, no graph database and no hosted service, and it supports three languages precisely before it supports many loosely. [ADR-021](decisions/ADR-021-agent-access-and-change-impact.md) records what it took from this comparison: agent access and change impact, done its own way.
