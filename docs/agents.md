# Using Epoch from an AI coding agent

`epoch mcp` lets an AI coding agent (Claude Code, Cursor, Codex and others that speak the [Model Context Protocol](https://modelcontextprotocol.io)) ask Epoch about your project instead of working it out by reading files one at a time:

- what depends on a file, and so what a change could break;
- what a set of changed files touches, and how risky each one is;
- how one file comes to depend on another;
- which files most of the project depends on, and which are riskiest;
- which code is likely unused (candidates with caveats, never verdicts).

The decisions behind this page are in [ADR-021](decisions/ADR-021-agent-access-and-change-impact.md).

## What it does and doesn't do

- **Local and offline.** The agent starts `epoch mcp` as a process on your machine and talks to it over standard input and output. There is no port and no HTTP server, and the server always runs with the network off.
- **Facts only.** Answers hold file paths, counts, risk tiers, import edges with their evidence, and candidates with their caveats. Never file contents, code excerpts, summaries or keys. The agent reads files with its own tools.
- **Read-only, including your agent's setup.** Epoch writes nothing into your project: no `AGENTS.md`, no hooks, no skills, no configuration. You add one line yourself, below.
- **What the agent does next is the agent's.** What it sends to its model provider is decided by the agent and its settings ([privacy.md](privacy.md)).
- **Fresh.** The server watches the project like the desktop app does. A question waits for a re-analysis in flight, so an answer reflects the files as they are. A file saved in the instant before a question can be missed until the next one.

## Getting the command

The CLI is packaged for npm as `@epoch-dev/cli` but not published yet. Once it is, the command is `npx -y @epoch-dev/cli mcp /path/to/your/project`, with nothing to build. Until then, build the CLI from a clone of this repository ([cli.md](cli.md)) and use the full path of the built file:

```sh
node /path/to/Epoch/packages/cli/dist/bin.js mcp /path/to/your/project
```

The examples below write `EPOCH` for `/path/to/Epoch/packages/cli/dist/bin.js`. The project path can be left out when the agent starts the server in the project folder; naming it is safer, because not every agent says which folder it starts servers in.

## Claude Code

From your project folder:

```sh
claude mcp add epoch -- node EPOCH mcp "$(pwd)"
```

- Everything after `--` is the command Claude Code runs.
- Without a scope flag the server is added for you, in this project only. `--scope user` adds it for all your projects; `--scope project` writes a `.mcp.json` in the project for your team, which is then your file, not Epoch's.
- Check it with `claude mcp list`, or `/mcp` inside a session.

Source: [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp), read 2026-11-15.

## Cursor

Create `~/.cursor/mcp.json` (for all projects) or `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "epoch": {
      "type": "stdio",
      "command": "node",
      "args": ["EPOCH", "mcp", "${workspaceFolder}"]
    }
  }
}
```

- `${workspaceFolder}` is the project root in a project's own `.cursor/mcp.json`. In the global file, write the project's path instead.
- Turn the server on or off under **Customize** in the sidebar; its log is "MCP Logs" in the Output panel.

Source: [Cursor's MCP documentation](https://cursor.com/docs/context/mcp), read 2026-11-15.

## Codex

```sh
codex mcp add epoch -- node EPOCH mcp /path/to/your/project
```

or, in `~/.codex/config.toml`:

```toml
[mcp_servers.epoch]
command = "node"
args = ["EPOCH", "mcp", "/path/to/your/project"]
```

Check it with `codex mcp list`, or `/mcp` inside a session.

Source: OpenAI's Codex documentation ([MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) and the config reference), read 2026-11-15. These pages could only be read in part, so confirm the syntax with `codex mcp --help` on your version.

## Other agents

Any MCP client that can start a local command works: the command is `node`, and the arguments are `EPOCH`, `mcp` and the project's path.

## The tools

| Tool           | Answers                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `overview`     | Languages and how precisely each is resolved, counts, risk tiers, open candidates, the most depended-on files |
| `find`         | Files whose path contains some text, to get the exact path the other tools take                               |
| `explain`      | One file: risk tier and the facts behind it, dependents, commits, coverage, imports, importers, candidates    |
| `blast_radius` | Every file that depends on a file, and how many imports away each is                                          |
| `impact`       | What changed files touch: each one's risk tier and candidates, and everything that depends on them            |
| `path`         | The shortest chain of imports from one file to another, or that neither depends on the other                  |
| `risk`         | Files by risk tier, then by how many files depend on them                                                     |
| `findings`     | Likely-dead candidates: branches that likely never run, possibly stale flags, possibly unused files           |

- A file is named by its path in the project, by an absolute path, or by any ending that fits exactly one file. A name that fits several is refused, with the candidates listed.
- Lists are capped (50 entries by default, 200 at most), and every answer says how many entries it left out.
- `blast_radius`, `impact` and `path` follow proven imports only, unless asked for `likely`, which also follows hint edges and marks what depends on them.
- `impact` takes either a list of files or a `base` commit to compare with HEAD.

## Things to ask

- "Before you change `src/auth/session.ts`, ask Epoch what depends on it."
- "Use Epoch to see what this branch touches compared with `main`, and tell me the riskiest file."
- "Why does `api/routes.ts` depend on `db/pool.ts`? Ask Epoch for the path."
- "Ask Epoch for likely unused files in `packages/legacy`, then check each one's caveats before suggesting anything."

## Limits

- The same limits as the rest of Epoch: imports that can't be resolved are listed as unresolved, not guessed, and a candidate is a prompt to review.
- File names, flag names and evidence in answers come from your repository. Epoch keeps them in data fields and tells the agent they are data, but it can't control what an agent does with what it reads.
- One server process per agent. Several agents can run at once; they share Epoch's cache.
- On a very large project the first answer waits for the first analysis.
