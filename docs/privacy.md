# Privacy and data flow

Epoch is local-first: your source code, the graph and the cache stay on your machine. There are no accounts, no hosted backend, no HTTP server and no telemetry. Epoch never modifies an analyzed project, and it never runs the project's code, scripts or configuration.

This page is the data-flow table that [CLAUDE.md](../CLAUDE.md) requires. Any new network call must be added here first.

## What leaves the machine

| Feature                                                       | What leaves the machine                                                          | Default             | Status today                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------- | ------------------------------------------- |
| Parsing, graph, blast radius, risk score, git analysis        | Nothing                                                                          | On                  | Built                                       |
| Dead-feature detection (reachability, constants, git history) | Nothing                                                                          | On                  | Built                                       |
| Heuristic scorer, co-change and shared-string hints           | Nothing                                                                          | On                  | Built                                       |
| Embeddings similarity                                         | Nothing (a small local embedding model, bundled with the app; chosen in ADR-008) | On                  | Not built yet: the model is not bundled yet |
| Local-model scorer and summaries (e.g. Ollama)                | Nothing (requests go to the model server on this machine)                        | Opt-in              | Not built yet                               |
| Jev scorer                                                    | Code snippets and context sent to TypeSafe AI                                    | Opt-in              | Not built yet                               |
| LLM summaries and LLM scorer                                  | File source and neighbor summaries sent to the model provider                    | Opt-in              | Not built yet                               |
| Update check                                                  | A request to the release host for the latest version. No project data            | On; can be disabled | Not built yet (M8)                          |

With no keys configured and update checks disabled, Epoch makes no network requests. Today none of the network features are built, so Epoch's own code sends nothing; the automated test that runs a full analysis with the network blocked arrives with offline mode (M7).

## Notes

- **Git.** Epoch runs `git` on your machine to read history (churn, co-change, when a line last changed). It only reads commits that are already there and never fetches. It runs read-only commands with the fsmonitor hook, signature checks, external diff and text-conversion drivers and the pager turned off, so a repository's own git configuration cannot make it run anything.
- **Hints.** Co-change and shared-string hints are computed on your machine from your git history and the files' own key-like strings. The cache keeps those short strings (event names, routes, keys), never file contents.
- **The embedding model will be downloaded when Epoch is built, not when it runs.** The build will fetch a pinned model revision and check its hash, and the installer will carry the model, so the installed app never downloads it. If the model is missing, similarity hints are simply off (as they are today).
- **Remote models are off by default.** When they exist, they will run only with your own key, after showing exactly what will be sent and asking for consent. Files that look like secrets (`.env*`, keys, credentials) are never sent, even with consent. Offline mode will block every outbound request.
- **Exports are explicit.** Sharing means writing a file you choose and sharing it yourself.
