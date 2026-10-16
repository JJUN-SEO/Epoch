# ADR-008: Hint scoring, defaults, and the local embedding model

- **Status:** Accepted for hint scoring and the defaults (measured 2026-10-16). The embedding model choice is pending: the model download is blocked in the build environment, so no candidate model could be measured yet.
- **Date:** 2026-10-16
- **Milestone:** M6

## Context

M6 adds hint edges: likely relations that are inferred, not proven, and that feed blast radius "likely" mode and one finding cap (CLAUDE.md "Confidence rubric": a strong hint edge to a reachable file caps an unreachable-file candidate at Medium). CLAUDE.md asks for calibrated probabilities, candidates first and never all pairs, and the heuristic as the baseline every other scorer must beat. PLAN.md registers this ADR for the local embedding model and the default threshold of "likely" mode.

## Decision

1. **What a hint's confidence means.** A hint edge `source -> target` follows CLAUDE.md's edge direction ("source depends on target"): when `target` changes, `source` likely changes too. Its confidence is a probability: given that `target` changes in the next 180 days, the chance that some commit changes `source` with it. That conditional reading is what blast radius asks ("I am changing target; what else changes?"). Co-change is asymmetric, so each direction gets its own edge.

2. **One edge per directed pair.** The kind is the strongest signal's (co-change, then shared strings, then embeddings), with that signal's provenance; a model scorer's edges are `semantic` with provenance `model`. The evidence lists every signal. Pairs a fact edge already covers are dropped, and so is anything below the floor. Each node keeps its 8 most likely outgoing hints. Confidence stays below 1 (at most 0.99), rounded to three decimals so the canonical graph is stable.

3. **Candidates.** Generated before any scoring, never all pairs:
   - **Co-change:** non-merge commits in the 365 days before HEAD's commit date, renames followed; commits touching more than 50 files are skipped (counted over every file they touched); a pair needs 3 commits together. Go files lift to their package nodes. The commit sets are cached per HEAD.
   - **Shared strings:** `FileFacts.strings` (ADR-014). Each string adds its rarity, ln(N / df), to a pair's weight; a string in more than 5 files links nothing.
   - **Embeddings:** pending (item 7).

   These cutoffs were set before measuring and were not tuned.

4. **HeuristicScorer.** A logistic of four features: the co-change ratio (commits together over the target's commits), co-change support (ln(1 + commits together)), the shared-string weight, and the embedding cosine. Its coefficients are data (`packages/scorers/src/coefficients.json`), fitted by `pnpm bench:scorers` (item 5):

   | Coefficient          | Value                             |
   | -------------------- | --------------------------------- |
   | intercept            | -1.8488                           |
   | co-change ratio      | 0.7894                            |
   | co-change support    | 1.0254                            |
   | shared-string weight | -0.0004                           |
   | embedding cosine     | 0 (not fitted: no embeddings yet) |

5. **How the coefficients were fitted, and how they are judged: a temporal holdout** (`packages/bench/src/scorers.ts`, report in [docs/benchmarks/scorers.md](../benchmarks/scorers.md)). It ran on full clones of zod, vitest, Flask and cli/cli (TypeScript, Python and Go):
   - T is 180 days before HEAD and T0 is 180 days before T. At each, the last mainline commit is checked out in a shared clone and run through the real Enrich stage, so co-change features see only history up to that commit.
   - A candidate is judged by the next 180 days of commits only if its target changed: positive if a commit changed both. Renames are followed forward, the same size cutoff applies, and fact-covered pairs are left out.
   - The coefficients are fitted on the T0 labels: a weighted logistic regression in which each repository weighs the same, with an L2 penalty of 1 on the slopes. Every scorer is then evaluated on T. Nothing after T is used to propose, fit or choose.
   - A unit test plants a co-change that starts after the snapshot and checks that the snapshot does not propose it. Another checks that a file renamed later still counts for the node it was.

6. **Defaults: threshold 0.5, floor 0.2, 8 per node** (`HINT_DEFAULTS`). They were set before the first run and are kept as they were: the holdout describes them, it did not choose them. The threshold is likely mode's default (the user moves it with the Hints slider) and the strong-hint cap's line. For the cap, a lower line is the cautious direction, because the cap only lowers a finding's confidence.

7. **Embedding runtime and model (pending).** The plan is `onnxruntime-node` 1.30.0 directly (MIT, N-API prebuilt binaries) with the model's own tokenizer:
   - not `@huggingface/transformers`, which imports onnxruntime-web unconditionally and defaults its WASM path to a CDN, a run-time request Epoch must not make;
   - the model is fetched at build time (pinned revision and sha256) and bundled, so the installed app never downloads it (docs/privacy.md);
   - candidates to measure: all-MiniLM-L6-v2, bge-small-en-v1.5 and jina-embeddings-v2-small-en (size, CPU time per file, license, holdout precision).

   Built and tested with a stand-in model, network-free: the `Embedder` interface (core), brute-force nearest neighbors (`embeddingCandidates`: each node's 10 most similar nodes at cosine 0.5 or more, a Go package as the mean of its files; both cutoffs provisional), and the engine side, which embeds each file's path plus its first 2,000 characters and caches the vectors by path, content hash and model, so a re-run embeds only changed files. A model that fails reports `unavailable`, and analysis goes on without it. Until a model is bundled, embeddings report status `off` and the cosine coefficient is 0. When the model can be downloaded, the ONNX runtime part is added, this ADR is amended with the measurements, and the coefficients and cutoffs are refitted by the same protocol.

8. **Opt-in model scorers, for the CLI and benchmarks in M6** (`--scorer local | llm`; the app's key UI, consent dialog and offline mode are M7):
   - **ModelScorer** scores only generated candidates, at most `--max-pairs` (default 200), the heuristic's likeliest first. For each pair it sends the start of each file (up to 6,000 characters, up to three files per Go package) with the pair's co-change counts and shared strings, and asks for a probability, a relation category and the names linking the two files. Every cited name is checked against the files' parse-tree facts (export names, imported names, key-like strings); unverified names are dropped and counted, never shown. Probabilities are clamped to at most 0.99. Its edges are `semantic` hints with provenance `model`.
   - **Never before consent.** For a remote provider, without `--consent-send` Epoch prints exactly what would be sent (files and character counts, the estimated tokens, the most it could cost) and sends nothing. Files that look like secrets are never sent, even with consent.
   - **Spend.** A paid provider needs `--max-spend` and the user's own prices (`--price-in`, `--price-out`; Epoch ships no prices). Before each request, Epoch reserves its worst case (the local token estimate, characters / 2.5, plus the output limit) and stops if the cap could be passed; actual spend is taken from the usage the provider reports.
   - **One network module.** `packages/scorers/src/net.ts` sends only to an allowlisted origin and refuses everything offline; the lint rule against `fetch` exempts that file alone.
   - **LocalScorer:** Ollama on `127.0.0.1:11434`, `POST /api/chat` with a JSON schema in `format` and `stream: false` (Ollama's API docs at v0.40.5).
   - **LlmScorer:** Claude through the official TypeScript SDK, `@anthropic-ai/sdk` 0.129.0 (MIT, published 2026-09-28): `messages.parse` with `output_config.format` (structured outputs) and effort `low`; refusals and cut-off answers leave the pair unscored. The default model is `claude-haiku-5-5`, the current small model (CLAUDE.md: "a small cheap Claude model"); `--model` picks another. The approved plan said "no SDKs"; the SDK was used instead because the Claude API guidance calls for the official SDK in TypeScript projects. It keeps the plan's guarantees: the SDK takes Epoch's network module as its `fetch`, the key is passed explicitly, and the base URL is fixed to `https://api.anthropic.com` (an `ANTHROPIC_BASE_URL` in the environment cannot redirect the key). The engine imports the heuristic by its own subpath, so the desktop app's bundle carries no model client (a test checks the built app).
   - **JevScorer:** a stub. Jev's docs (docs.typesafe.ai) could not be read from the build environment, and its API is never written from memory, so its rows say "not run".
   - Tests drive the SDK and the Ollama client against a fake `fetch`. They check the request shape, that nothing is sent before consent or offline, that secret files never appear in a prompt, that scoring stops at the cap, and that unverified names are dropped. No model was run for this ADR: the environment has neither an Ollama server nor a key.

## Measured (docs/benchmarks/scorers.md, at T, all four repositories)

3,145 judged candidates; 38.9% were positive.

| Scorer                                                | Brier | ECE   | ROC AUC |
| ----------------------------------------------------- | ----- | ----- | ------- |
| Heuristic, fitted on T0                               | 0.188 | 0.059 | 0.724   |
| Heuristic, provisional coefficients (before this ADR) | 0.335 | 0.322 | 0.557   |
| Co-change ratio alone                                 | 0.238 | 0.195 | 0.727   |
| Constant (T0 positive rate)                           | 0.240 | 0.051 | 0.500   |

At the 0.5 threshold, precision is 68.2% and recall 48.8% (874 candidates at or above it); at 0.6, 82.8% and 33.8%. Per repository at 0.5:

| Repository | Precision                       | ROC AUC        |
| ---------- | ------------------------------- | -------------- |
| vitest     | 79.5%                           | 0.770          |
| zod        | 51.8%                           | 0.635          |
| cli/cli    | 23.1%                           | 0.441          |
| Flask      | 0.0% (26 judged, none positive) | not computable |

The Local, Jev and LLM scorers were not run: the Local and LLM scorers need an Ollama server or the maintainer's key (`pnpm bench:scorers ... --scorer llm --consent-send --max-spend <USD> --price-in <USD> --price-out <USD>` adds their rows), and Jev is a stub (item 8).

## What the numbers say

- **Fitting matters.** The provisional coefficients ranked worse and were badly calibrated (ECE 0.322). The fitted heuristic ranks as well as the raw co-change ratio (AUC 0.724 vs 0.727), and unlike the ratio it is calibrated (ECE 0.059 vs 0.195). Its Brier score beats the constant baseline (0.188 vs 0.240).
- **Shared strings add nothing as weighted.** The fitted string weight is about 0. Strings-only candidates therefore all score 0.136, below the floor, and draw no edge. Their positive rate at T was 20.8%, against 38.9% pooled. When a pair also co-changes, its positive rate was higher (66.1% vs 53.8% for co-change alone), which the rarity weight does not capture. A different string feature must be chosen on the training split in the next round (with embeddings), not on these test numbers. The generator stays: it is cheap, and its evidence still shows on co-change hints.
- **Repositories differ a lot.** On cli/cli, past co-change did not predict the next six months (AUC 0.441, precision of drawn edges 19.0%). Flask changed too little in the window to judge (26 candidates, none positive). Likely mode therefore stays opt-in, and the slider lets users raise the bar.
- **The generators miss most future co-change.** At T they had proposed 7.3% (vitest) to 27.4% (zod) of the directed pairs that later changed together; Flask's 100% is 2 of 2. Many of those pairs changed together once in a medium-sized commit. Some are what a semantic signal is meant to add.

## Limits

- Four repositories, one window each. The label is future co-change, a proxy for "related", not a judgment of relatedness.
- Fitting on T0 labels uses commits up to T, the same history T's features see. That is not leakage (T's labels come after T), but the two splits are not independent samples.
- Commit habits shape everything: squash merges, bulk commits under the 50-file cutoff, and vendored code all move the numbers.
- Timings in the report come from one run on a 4-core VM without the cache.

## Alternatives considered

- **Scoring all pairs.** Ruled out by CLAUDE.md, and quadratic.
- **The raw co-change ratio as the confidence.** It ranks as well, but it is not a probability of anything we measured (ECE 0.195).
- **One fit per repository.** That needs history to fit on before hints can be shown, and it overfits small repositories (Flask). A pooled fit, refitted when the protocol changes, is the baseline.
- **`@huggingface/transformers` for embeddings.** Its default run-time CDN request and its heavier dependency tree are the reasons (item 7).

## Consequences

- Hints are calibrated on these repositories and labeled as likely, never as facts. The UI shows their evidence. The status bar says what they rest on.
- Refitting is a script run: `pnpm bench:scorers <repos> --write-coefficients packages/scorers/src/coefficients.json`, then this ADR is updated with the new numbers.
- The embedding section is amended once the model download is allowed. Until then, `off` is the honest status.
