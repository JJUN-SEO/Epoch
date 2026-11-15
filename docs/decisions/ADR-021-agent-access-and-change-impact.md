# ADR-021: Agent access over MCP, change impact, and graph queries

- **Status:** Accepted (approved with the M9 plan, 2026-11-15)
- **Date:** 2026-11-15
- **Milestone:** M9 (post-MVP)

## Context

The maintainer compared Epoch with two code-graph tools, GitNexus and Graphify, before pitching it. Both lead with the same two things Epoch lacked:

1. **Agent access.** An AI coding agent (Claude Code, Cursor, Codex) asks the tool about the codebase instead of reading files one by one.
2. **Change impact.** What a diff or a pull request touches.

Both also offer the path between two things and clusters of related code. Epoch had blast radius for one selected node, in the app and in the static demo, and nothing an agent or a CI job could ask.

What Epoch has that neither documents: risk tiers from history and coverage, dead-feature candidates, and never writing into the project. So the aim is not to copy their graphs but to let an agent and a pull request ask Epoch's own questions.

The maintainer decided (2026-11-15):

- Agents reach Epoch **through the CLI, published to npm**. The existing commands stay as they are.
- Epoch does not try to match either tool's whole feature list (CLAUDE.md non-goal: competing on breadth).

## Sources (read 2026-11-15)

- **MCP TypeScript SDK v2**, [documentation](https://ts.sdk.modelcontextprotocol.io/v2/) (the tools, stdio serving and client pages) and the type definitions shipped in `@modelcontextprotocol/server@2.4.0`:
  - `new McpServer({ name, version }, options)`; `options.instructions` is "Optional instructions describing how to use the server and its features".
  - `server.registerTool(name, config, handler)`; `config` takes `title`, `description`, `inputSchema` and `outputSchema` (zod object schemas) and `annotations` (for example `readOnlyHint`). A handler returns `content` and, with an `outputSchema`, `structuredContent`, which the SDK validates.
  - `serveStdio(factory, options)` from `@modelcontextprotocol/server/stdio` owns the transport and returns a handle with `close()`.
  - The stdio page: "Log to stderr, never stdout": stdout is the JSON-RPC channel.
  - The transport closes itself when the client closes stdin, so a server with no other handles exits.
  - v2 implements the 2026-07-28 MCP specification and still serves clients that open with the 2025 handshake.
- **npm registry:**
  - `@modelcontextprotocol/server@2.4.0`: Apache-2.0, Node 20 or later, dependencies `zod ^4.2.0` and `@modelcontextprotocol/core@2.4.0` (which depends on zod only).
  - `@modelcontextprotocol/sdk@1.32.2` (the v1 line): its dependencies include `express`, `hono`, `cors` and `@hono/node-server`.
  - `@modelcontextprotocol/client@2.4.0`: Apache-2.0; has a stdio entry that starts a server as a child process.
  - `graphology-communities-louvain@2.0.2`: MIT; options `randomWalk` (default true), `rng` and `resolution`.
- **GitNexus** [README](https://github.com/abhigyanpatwari/GitNexus) and MCP reference: `analyze` "builds the index, installs agent skills, registers Claude Code hooks, and writes `AGENTS.md` / `CLAUDE.md` context files"; its tools include `impact`, `trace`, `detect_changes` and `rename`; MCP also runs over HTTP.
- **Graphify** [README](https://github.com/safishamsi/graphify): `graphify <platform> install` "writes a small config file" and, on hook platforms, a hook before search-style tool calls; `query`, `path` and `explain` run against `graph.json`.

## Decision

### 1. Three pure functions in `core`

Beside `blastRadius`, shared by the CLI, the agent server, the renderer and the static demo. None is stored in the `Graph`, so the canonical form and `schemaVersion` do not change.

- **`dependencyPath(graph, from, to, opts)`:** the shortest chain of edges from `from` to a node it depends on.
  - Follows the same edge kinds as blast radius, with the same options (mode, type-only toggle, hint threshold).
  - A chain of fact edges is preferred. In likely mode, a chain that needs hint edges is returned only when no fact chain exists, and each hop says whether it is a hint.
  - Each hop carries its edge kind and evidence. Ties break by node id, so the answer is stable.
- **`changeImpact(graph, changed, opts)`:** for a set of changed files:
  - each changed node with its risk tier and the candidates located in it;
  - the combined blast radius: one reverse BFS from all changed nodes at once, so a node is counted once at its shortest depth, with blast radius's report (depth, directory, language, hint dependence);
  - changed paths that are not nodes (documentation, deleted files, files outside the analyzed languages) listed, not dropped.
- **`clusters(graph)`:** groups of nodes that depend mostly on each other.
  - Louvain over the certain edge set, treated as undirected, with `randomWalk: false` and nodes added in id order, so the same graph always gives the same clusters.
  - A cluster is named after its most depended-on node. Nodes with no certain edge are left unclustered.
  - A view only: never a fact edge, a finding or an input to risk.

### 2. CLI commands

```
epoch impact <path> (--base <ref> | --files <file>...) [--json] [--markdown] [--likely] [--fail-on <tier>]
epoch path <path> <from> <to> [--json] [--likely]
epoch explain <path> <file> [--json]
epoch export <path> --format graphml|mermaid|dot [--out <file>]
epoch mcp [<path>]
```

- `impact --base` compares two commits' trees through the existing `changedSince` (`packages/engine/src/git.ts`), which never reads the working tree or the index. `--files` takes paths directly, for "what would changing these affect".
- `--fail-on <tier>` exits with code 2 when a changed node is at or above the tier, like `epoch findings`.
- `export` prints to stdout, or writes the file the user names with `--out`: an explicit export (principle 2).

### 3. The agent server

- **Transport:** MCP over stdio only. No HTTP, no port, no listener (CLAUDE.md: no local HTTP server).
- **Library:** `@modelcontextprotocol/server@2.4.0`, importing only its root and `./stdio`. Pinned.
- **Tools, all read-only and marked `readOnlyHint`:** `overview`, `find`, `explain`, `blast_radius`, `impact`, `path`, `risk`, `findings`.
- **What a result holds:** graph facts only: node ids (repository-relative paths), metrics, risk tiers and the facts behind them, edges with kind and evidence, and findings with their rubric wording, evidence and caveats.
  - Never file contents, code excerpts, summaries or keys. An agent reads files with its own tools.
  - Lists are capped, and a capped result says how many there were.
- **Always offline.** The server makes no network request and runs no model feature, whatever the settings say.
- **Read-only, including the agent's own setup.** Epoch writes no `AGENTS.md`, `.mcp.json`, hook or skill into the project or the user's agent configuration. `docs/agents.md` shows the line the user adds.
- **Freshness.** The project is analyzed when the server starts. Before a tool answers, an incremental analysis picks up changed files through the shared cache.
- **Repository strings are data.** File names, flag names and evidence come from the analyzed repository and can say anything. Results put them in structured fields, and the server's `instructions` say they are data from the repository, never instructions.

### 4. Privacy

A new row in the data-flow table: Epoch sends nothing. The agent that started the server receives graph facts over stdio, and what that agent sends to its model provider is the agent's. Opt-in: the server runs only when the user adds it to an agent.

## Alternatives considered

- **The v1 SDK (`@modelcontextprotocol/sdk`).** Rejected: it installs HTTP frameworks Epoch would never use, in a project whose promise is no HTTP server.
- **Speaking JSON-RPC by hand.** Rejected for now: the protocol's handshake changed between the 2025 and 2026 revisions, and the SDK serves both. It remains the fallback if the SDK cannot be bundled.
- **Serving agents from the desktop app.** Rejected: the installers turn off Electron's run-as-Node fuse (ADR-018), so the app would have to start windowless and speak on stdio, unproven on three systems, and it would only work on a desktop with the app installed, not in CI or a cloud agent.
- **Installing hooks, skills or `AGENTS.md`, as both other tools do.** Rejected: it writes into the project (principle 2). The user adds one line themselves.
- **A file-reading or search tool in the server.** Rejected: agents have their own, and it would make the server a second way to read source.
- **A rename tool.** Rejected: it edits the project.
- **Storing clusters in the `Graph`.** Rejected: a derived view would enter the canonical form and the equivalence test for no gain; it is cheap to compute on demand.
- **An HTTP transport for several agents at once.** Rejected: no HTTP server. Each agent starts its own process, and they share the cache.

## Consequences

- Two new dependencies in the CLI (`@modelcontextprotocol/server`, and `@modelcontextprotocol/client` for tests only) and one in `core` (`graphology-communities-louvain`).
- A second surface for the "no source leaves through Epoch" promise. A test puts a marker in fixture file bodies and asserts it appears in no tool result; another asserts the fixture folder is byte-identical after a session; the zero-network test covers a session.
- A hostile repository can still name a file to read like an instruction. Epoch cannot make an agent ignore it; it only keeps such strings in data fields, says so, and returns no file contents.
- Tool results cost the agent tokens, so the caps are part of the contract and tested.
- The CLI becomes something users install, so it must be published (ADR-018 amendment, M9.5).
