# ADR-008: Hint scoring, defaults, and the local embedding model

- **Status:** Accepted (measured 2026-10-16): hint scoring, the defaults, the embedding runtime and delivery, and the embedding model, all-MiniLM-L6-v2 (item 7).
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
   - **Embeddings:** each file's nearest neighbors by a local model (all-MiniLM-L6-v2, item 7).

   These cutoffs were set before measuring and were not tuned.

4. **HeuristicScorer.** A logistic of four features: the co-change ratio (commits together over the target's commits), co-change support (ln(1 + commits together)), the shared-string weight, and the embedding cosine. Its coefficients are data (`packages/scorers/src/coefficients.json`), fitted by `pnpm bench:scorers` (item 5):

   | Coefficient          | Candidates without a cosine | Candidates with a cosine (all-MiniLM-L6-v2) |
   | -------------------- | --------------------------- | ------------------------------------------- |
   | intercept            | -1.8488                     | -3.1931                                     |
   | co-change ratio      | 0.7894                      | 0.5184                                      |
   | co-change support    | 1.0254                      | 1.3357                                      |
   | shared-string weight | -0.0004                     | -0.0017                                     |
   | embedding cosine     | 0 (no cosine)               | 1.5243                                      |

5. **How the coefficients were fitted, and how they are judged: a temporal holdout** (`packages/bench/src/scorers.ts`, report in [docs/benchmarks/scorers.md](../benchmarks/scorers.md)). It ran on full clones of zod, vitest, Flask and cli/cli (TypeScript, Python and Go):
   - T is 180 days before HEAD and T0 is 180 days before T. At each, the last mainline commit is checked out in a shared clone and run through the real Enrich stage, so co-change features see only history up to that commit.
   - A candidate is judged by the next 180 days of commits only if its target changed: positive if a commit changed both. Renames are followed forward, the same size cutoff applies, and fact-covered pairs are left out.
   - The coefficients are fitted on the T0 labels: a weighted logistic regression in which each repository weighs the same, with an L2 penalty of 1 on the slopes. Every scorer is then evaluated on T. Nothing after T is used to propose, fit or choose.
   - A unit test plants a co-change that starts after the snapshot and checks that the snapshot does not propose it. Another checks that a file renamed later still counts for the node it was.

6. **Defaults: threshold 0.5, floor 0.2, 8 per node** (`HINT_DEFAULTS`). They were set before the first run and are kept as they were: the holdout describes them, it did not choose them. The threshold is likely mode's default (the user moves it with the Hints slider) and the strong-hint cap's line. For the cap, a lower line is the cautious direction, because the cap only lowers a finding's confidence.

7. **Embedding runtime (built) and model (pending measurement).**
   - **Runtime:** `onnxruntime-node` 1.30.0 (MIT, N-API prebuilt binaries) on the CPU, with `@huggingface/tokenizers` 0.2.0 (Apache-2.0, pure JavaScript, no network code). Not `@huggingface/transformers`, which imports onnxruntime-web unconditionally and defaults its WASM path to a CDN, a run-time request Epoch must not make. For each candidate model's tokenizer, the JavaScript token ids were checked against Hugging Face's Rust tokenizer (0.22.1) on a fixed set of code strings; the ids are a test fixture, rechecked whenever a model is present.
   - **Determinism:** texts run one at a time. Padded into a batch, the same text gets a vector that differs in the last bits (the runtime picks other kernels for other shapes), which would make a cached vector differ from a fresh one. Cosines are rounded to 1e-4.
   - **Text and neighbors:** each file's path plus its first 2,000 characters, cut to the model's token limit, pooled as the model was trained (mean or [CLS]) and normalized. Brute-force nearest neighbors (`embeddingCandidates`): each node's 10 most similar nodes at cosine 0.5 or more, a Go package as the mean of its files; both cutoffs provisional. With a model, every candidate whose nodes have vectors gets its cosine, so "no signal" is never read as "similarity 0".
   - **Two coefficient sets:** one for candidates without a cosine (no model, or a model that failed), one for candidates with one, each fitted on its own view of the T0 candidates (item 4). With the second set, a candidate proposed only by similarity scores at most σ(−3.1931 + 1.5243) = 0.159 (at cosine 1), below the floor: the model alone never draws an edge. It re-ranks what co-change and shared strings propose.
   - **Cache:** vectors are cached by path, content hash and model id (`<id>@<revision>`), numbers only, never source, so a re-run embeds only changed files. The runtime starts on the first file that needs a vector; a run whose vectors are all cached never loads it.
   - **Delivery:** `models/manifest.json` pins each candidate to a Hugging Face revision and each file to its size and sha256; `scripts/fetch-model.mjs` downloads them at build time into the gitignored `models/<id>/` (CI does this before the tests and before packaging). The installer carries the manifest's default as `resources/model` (electron-builder `extraResources`, checked against the manifest by a test). The installed app never downloads a model (docs/privacy.md).
   - **Packaging:** electron-builder keeps only the build platform's and target architecture's runtime: 45 MB on Linux x64 (in the packaged app), and from the npm package's files, 44.6 MB on macOS arm64 (the binding loads `libonnxruntime.1.dylib`; the versioned file next to it is a byte-identical copy and is left out), 64 MB on Windows x64 (with the DirectML libraries the runtime ships; whether the CPU-only path can drop them is untested). The package also carries the runtime's install-script dependencies (`global-agent`, `adm-zip`), which nothing loads at run time.
   - **No Intel-Mac runtime:** `onnxruntime-node` 1.30.0 ships no `darwin/x64` binary. There the model fails to start and similarity reports `unavailable`; everything else works. Whether to ship an Intel-Mac build at all is M8's call.
   - **In the app:** the analysis host sends the first graph without similarity hints, marked `pending`, then the watcher re-analyzes with the model and sends the difference, and keeps the model for later changes. `EPOCH_EMBEDDING_MODEL=off` turns the model off; a packaged app takes nothing else from that variable. In the CLI, `--embedding-model <dir>` (or `EPOCH_EMBEDDING_MODEL`) names a model folder; without it, similarity is off.
   - **Model: all-MiniLM-L6-v2** (Apache-2.0, 90.4 MB ONNX, 384 dimensions, 256 tokens). The three candidates ran through `pnpm bench:scorers --embedding-model models/<id>` one after another on the same 4-core VM; each report fits and evaluates both coefficient sets ([all-MiniLM-L6-v2](../benchmarks/scorers.md), refitted as the shipped report; [bge-small-en-v1.5](../benchmarks/scorers-bge-small-en-v1.5.md); [jina-embeddings-v2-small-en](../benchmarks/scorers-jina-embeddings-v2-small-en.md)):

     | Model                       | License, ONNX file   | CPU time per file | Enrich stage without a cache (zod / vitest / cli/cli) | Candidate recall at T (zod / vitest / cli/cli) | ROC AUC, every candidate | ROC AUC, the pairs proposed without a model | Drawn edges at 0.5+, precision (zod / vitest / cli/cli) |
     | --------------------------- | -------------------- | ----------------- | ----------------------------------------------------- | ---------------------------------------------- | ------------------------ | ------------------------------------------- | ------------------------------------------------------- |
     | all-MiniLM-L6-v2            | Apache-2.0, 90.4 MB  | 21.6 ms           | 10.3 / 46.2 / 22.2 s                                  | 43.6% / 17.2% / 38.6%                          | 0.707                    | 0.763                                       | 61.0% / 70.0% / 22.9%                                   |
     | bge-small-en-v1.5           | MIT, 133.1 MB        | 72.1 ms           | 36.7 / 136.2 / 77.8 s                                 | 43.6% / 18.0% / 48.1%                          | 0.724                    | 0.767                                       | 58.6% / 72.5% / 24.1%                                   |
     | jina-embeddings-v2-small-en | Apache-2.0, 129.8 MB | 95.9 ms           | 58.0 / 152.2 / 117.1 s                                | 40.5% / 18.0% / 45.8%                          | 0.723                    | 0.766                                       | 57.3% / 74.1% / 23.9%                                   |
     | no model                    |                      |                   |                                                       | 27.4% / 7.3% / 20.9%                           |                          | 0.724                                       |                                                         |

     Why the smallest: the quality differences are within 0.02 of AUC and a few points of precision, in both directions, and the drawn edges are the same in number (207, 901, 4 and 346 on the four repositories) because similarity-only candidates never pass the floor. bge-small finds more future co-change on cli/cli (48.1% vs 38.6% candidate recall), but those extra candidates are similarity-only and draw nothing. MiniLM is 3.3 to 4.4 times faster per file: on vitest's 2,259 files the first analysis spends 46 s embedding in the background instead of 136 to 152 s. Its 256-token limit cuts a file's start shorter than the others' 512 and 8,192 tokens; the measurements include that. (MiniLM's timings are from the shipped report, run on its own on the same idle host; in the run just before bge and jina it measured 22.5 ms per file.)

   - **Quantized files, not measured.** The pinned revision also carries 23.0 MB int8 files, one per CPU family (arm64, avx2, avx512, avx512-vnni). Using them means a different model file per installer architecture, each with its own quality run; M8 weighs that against installer size. Until then the installer carries the 90.4 MB fp32 file, the same on every platform.

8. **Opt-in model scorers, for the CLI and benchmarks in M6** (`--scorer local | llm`; the app's key UI, consent dialog and offline mode are M7):
   - **ModelScorer** scores only generated candidates, at most `--max-pairs` (default 200), the heuristic's likeliest first. For each pair it sends the start of each file (up to 6,000 characters, up to three files per Go package) with the pair's co-change counts and shared strings, and asks for a probability, a relation category and the names linking the two files. Every cited name is checked against the files' parse-tree facts (export names, imported names, key-like strings); unverified names are dropped and counted, never shown. Probabilities are clamped to at most 0.99. Its edges are `semantic` hints with provenance `model`.
   - **Never before consent.** For a remote provider, without `--consent-send` Epoch prints exactly what would be sent (files and character counts, the estimated tokens, the most it could cost) and sends nothing. Files that look like secrets are never sent, even with consent.
   - **Spend.** A paid provider needs `--max-spend` and the user's own prices (`--price-in`, `--price-out`; Epoch ships no prices). Before each request, Epoch reserves its worst case (the local token estimate, characters / 2.5, plus the output limit) and stops if the cap could be passed; actual spend is taken from the usage the provider reports.
   - **One network module.** `packages/scorers/src/net.ts` sends only to an allowlisted origin and refuses everything offline; the lint rule against `fetch` exempts that file alone.
   - **LocalScorer:** Ollama on `127.0.0.1:11434`, `POST /api/chat` with a JSON schema in `format` and `stream: false` (Ollama's API docs at v0.40.5).
   - **LlmScorer:** Claude through the official TypeScript SDK, `@anthropic-ai/sdk` 0.129.0 (MIT, published 2026-09-28): `messages.parse` with `output_config.format` (structured outputs) and effort `low`; refusals and cut-off answers leave the pair unscored. The default model is `claude-haiku-5-5`, the current small model (CLAUDE.md: "a small cheap Claude model"); `--model` picks another. The approved plan said "no SDKs"; the SDK was used instead because the Claude API guidance calls for the official SDK in TypeScript projects. It keeps the plan's guarantees: the SDK takes Epoch's network module as its `fetch`, the key is passed explicitly, and the base URL is fixed to `https://api.anthropic.com` (an `ANTHROPIC_BASE_URL` in the environment cannot redirect the key). The engine imports the heuristic by its own subpath, so the desktop app's bundle carries no model client (a test checks the built app).
   - **JevScorer:** built in ADR-017 (TypeSafe's HTTP API, from its docs read 2026-10-17), behind the same `ModelScorer` path, guards and spend cap. Until then it was a stub, because docs.typesafe.ai could not be read and its API is never written from memory.
   - Tests drive the SDK and the Ollama client against a fake `fetch`. They check the request shape, that nothing is sent before consent or offline, that secret files never appear in a prompt, that scoring stops at the cap, and that unverified names are dropped. No model was run for this ADR: the environment has neither an Ollama server nor a key.

## Measured (docs/benchmarks/scorers.md, at T, all four repositories)

### Without a model

The candidates co-change and shared strings propose: what the app scores where the model is unavailable. 3,145 judged candidates; 38.9% were positive.

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

### With the model (all-MiniLM-L6-v2)

Every candidate, each with its cosine: 15,472 judged, 12,327 of them proposed by similarity alone; 18.0% were positive.

| Scorer                                                      | Brier | ECE   | ROC AUC |
| ----------------------------------------------------------- | ----- | ----- | ------- |
| Heuristic with a model, fitted on T0                        | 0.126 | 0.027 | 0.707   |
| Heuristic without a model (similarity-only candidates at 0) | 0.139 | 0.113 | 0.659   |
| Cosine alone                                                | 0.464 | 0.566 | 0.501   |
| Co-change ratio alone                                       | 0.149 | 0.141 | 0.638   |
| Constant (T0 positive rate)                                 | 0.148 | 0.015 | 0.500   |

On the 3,145 candidates proposed without a model, the cosine raises ROC AUC from 0.724 to 0.763, at slightly worse calibration (ECE 0.080 vs 0.059, Brier 0.190 vs 0.188). Per repository, ROC AUC with the model is 0.768 (zod), 0.731 (vitest) and 0.560 (cli/cli); Flask had 51 judged candidates, none positive. The drawn edges (floor 0.2, at most 8 per node) were right at 0.5 or above 61.0% (zod), 70.0% (vitest) and 22.9% (cli/cli) of the time.

The Local and LLM scorers were not run: they need an Ollama server or the maintainer's Anthropic key (`pnpm bench:scorers ... --scorer llm --consent-send --max-spend <USD> --price-in <USD> --price-out <USD>` adds their rows). Jev was run on 2026-10-17 (ADR-017): on the 1,508 judged pairs among the heuristic's top 1,000 per repository, ROC AUC 0.800 against the fitted heuristic's 0.826 on the same pairs, Brier 0.196 against 0.171, ECE 0.121 against 0.059.

## What the numbers say

- **Fitting matters.** The provisional coefficients ranked worse and were badly calibrated (ECE 0.322). The fitted heuristic ranks as well as the raw co-change ratio (AUC 0.724 vs 0.727), and unlike the ratio it is calibrated (ECE 0.059 vs 0.195). Its Brier score beats the constant baseline (0.188 vs 0.240).
- **Shared strings add nothing as weighted.** The fitted string weight is about 0. Strings-only candidates therefore all score 0.136, below the floor, and draw no edge. Their positive rate at T was 20.8%, against 38.9% pooled. When a pair also co-changes, its positive rate was higher (66.1% vs 53.8% for co-change alone), which the rarity weight does not capture. The refit with the model gives the same answer (−0.0017). A different string feature must be chosen on the training split, not on these test numbers. The generator stays: it is cheap, and its evidence still shows on co-change hints.
- **Repositories differ a lot.** On cli/cli, past co-change did not predict the next six months (AUC 0.441 without the model, 0.560 with it; precision of drawn edges 18.8%). Flask changed too little in the window to judge (26 candidates, none positive). Likely mode therefore stays opt-in, and the slider lets users raise the bar.
- **The generators miss most future co-change.** At T they had proposed 7.3% (vitest) to 27.4% (zod) of the directed pairs that later changed together; Flask's 100% is 2 of 2. Many of those pairs changed together once in a medium-sized commit. With the model the generators proposed 17.2% (vitest) to 43.6% (zod).
- **The model re-ranks; it adds no edges yet.** Similarity alone does not rank (cosine alone: AUC 0.501), and similarity-only candidates were positive 12.7% of the time against 18.0% pooled, so fitted, they all score below the floor. What the cosine adds is order among the pairs co-change and shared strings propose (AUC 0.724 to 0.763). The candidate recall it adds therefore reaches no graph today; a better semantic feature, or a model scorer judging those candidates (item 8), is how it could.

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
- The cosine coefficient belongs to all-MiniLM-L6-v2: another model's cosines sit on another scale, so changing the model means refitting (`pnpm bench:scorers <repos> --embedding-model models/<id> --write-coefficients packages/scorers/src/coefficients.json`) and updating this ADR.
