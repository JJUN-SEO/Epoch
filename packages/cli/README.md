# @epoch-dev/cli

The command line of [Epoch](https://github.com/JJUN-SEO/Epoch): it parses a TypeScript/JavaScript, Python or Go project into a dependency graph and answers, on your machine:

- **What depends on this file?** Blast radius, and the chain of imports between two files.
- **How risky is it to touch?** A tier from three facts you can check: how many files depend on it, how often it changed in the last 90 days, and its size or test coverage.
- **What does this change touch?** For a pull request or a list of files.
- **What is likely unused?** Branches that likely never run, possibly stale feature flags and possibly unused files: candidates with evidence and caveats, never verdicts.

It reads your project and never changes or runs it. There is no account, no server and no telemetry.

## Use

Node 24 or later.

```sh
npx @epoch-dev/cli analyze .                      # the graph, with a summary
npx @epoch-dev/cli impact . --base origin/main    # what a branch touches
npx @epoch-dev/cli explain . src/auth/session.ts  # one file's facts
npx @epoch-dev/cli path . src/api.ts src/db.ts    # how one file depends on another
npx @epoch-dev/cli findings . --fail-on high      # candidates; exit code 2 for CI
npx @epoch-dev/cli --help
```

Installed (`npm install -g @epoch-dev/cli`), the command is `epoch`.

## From an AI coding agent

`epoch mcp` is a read-only [MCP](https://modelcontextprotocol.io) server over standard input and output: no port, always offline, graph facts only, never file contents. For Claude Code, from your project folder:

```sh
claude mcp add epoch -- npx -y @epoch-dev/cli mcp "$(pwd)"
```

Cursor, Codex and the tools it offers: [docs/agents.md](https://github.com/JJUN-SEO/Epoch/blob/main/docs/agents.md).

## Good to know

- **Similarity hints are not in this package.** They need a local embedding model and `onnxruntime-node` (about 290 MB), which the desktop app carries. Everything else works the same.
- The cache lives in your user cache folder (`EPOCH_CACHE_DIR` moves it) and is safe to delete: `epoch cache clear`.
- Every command and option: [docs/cli.md](https://github.com/JJUN-SEO/Epoch/blob/main/docs/cli.md). What leaves your machine (nothing, unless you opt in to a model with your own key): [docs/privacy.md](https://github.com/JJUN-SEO/Epoch/blob/main/docs/privacy.md).

MIT license.
