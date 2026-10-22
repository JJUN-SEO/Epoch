# ADR-017: JevScorer, TypeSafe AI's Jev over its HTTP API

- **Status:** Accepted (built and measured 2026-10-17)
- **Date:** 2026-10-17
- **Milestone:** M6 (ADR-008 item 8 left Jev a stub because its docs could not be read)

## Context

CLAUDE.md lists four `RelationScorer` backends; JevScorer is TypeSafe AI's Jev, a "System One" model with typed, calibrated outputs, opt-in and with the user's own key. PLAN.md and CLAUDE.md say to build it only from TypeSafe's current docs, cite them, and pin versions. ADR-001 records that the maintainer has early access. The build environment can now reach docs.typesafe.ai and api.typesafe.ai.

## Sources (read 2026-10-17)

Every API detail below comes from these pages. Nothing was taken from search snippets or memory.

- API reference: https://docs.typesafe.ai/api.md (endpoint, request rules, question and answer types, errors)
- Models: https://docs.typesafe.ai/models.md (model ids, aliases, price, context length, rate limits, data handling)
- Noul: https://docs.typesafe.ai/primitives/noul.md; Choice: https://docs.typesafe.ai/primitives/choice.md
- State: https://docs.typesafe.ai/concepts/state.md
- Jev 1.13 jaggedness: https://docs.typesafe.ai/model-jaggedness/jev-1.13.md (last reviewed by TypeSafe 2026-10-02)
- Legal: https://docs.typesafe.ai/legal.md
- JavaScript SDK: https://docs.typesafe.ai/sdk/javascript.md
- Index: https://docs.typesafe.ai/llms.txt

- Legal documents (read 2026-10-17): Data Processing Addendum, https://typesafe.ai/legal/data-processing (last updated 2026-04-24); Privacy Policy, https://typesafe.ai/legal/privacy-policy (last updated 2025-11-19); Master Customer Agreement, https://typesafe.ai/legal/mca (last updated 2026-09-23). Subprocessors are listed at https://trust.typesafe.ai/subprocessors, which was not read.

## What the docs say

- **Endpoint.** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`. The body has `state` (string, object or array), `model`, and `questions`, a map of ids you choose to typed questions. The answers come back under the same ids, with `model` (the versioned id that answered) and `usage` (`input_tokens`, `output_tokens`).
- **Question types used here.** `noul`: a yes/no question (`instructions`, optional `criteria.true` and `criteria.false`); the answer is `{ type: "noul", noul }`, 0 (no) to 1 (yes). `choice`: one option of a map `criteria` (at most 255); the answer is `{ type: "choice", choice, probabilities, confidence }`.
- **Request rules.** At most 32 MiB, UTF-8 JSON without a BOM, at most 64 nesting levels, finite numbers only. Context: 64k tokens per request and 32k per question, by default.
- **Errors.** 400 (a broken rule; `max_tokens_exceeded` if over the context), 401 (missing or invalid key), 413, 415, 422 (validation), 429 (rate limit), 529 (overloaded). On 429 and 529, retry with exponential backoff; the SDKs follow `retry-after` when sent. Rate limits are per organization, in tokens and requests per second.
- **Models and price.** `jev-1.14.0` (from 2026-10-14) and `jev-1.13.0`, both \$0.042 per million input tokens; "Output tokens are free." `jev-latest` points to `jev-1.13.0` and `jev-preview` to `jev-1.14.0`; aliases move, so the docs advise sending a versioned id once thresholds are tuned against it.
- **Data handling.** "Jev is not trained on customer requests or responses" (models.md). The legal documents agree and say more:
  - **Training:** the Privacy Policy says TypeSafe "will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input"; the MCA (section 4.1) says it will not put Customer Data in a training dataset "without Customer's prior consent".
  - **Retention:** no fixed period. The DPA keeps personal data "for as long as necessary taking into account the purpose of the Processing" and the Privacy Policy "for as long as reasonably necessary to provide you with the Services". Zero data retention is offered to enterprise customers only.
  - **Other use:** the MCA (section 4.1(c)) grants TypeSafe a perpetual right to use Customer Data, which includes the Input Epoch sends (file excerpts), to derive telemetry, monitor for fraud and abuse, and comply with law. Input goes to no third party other than TypeSafe's service providers (Privacy Policy).
- **Known weaknesses.** Literal reading, numbers and counting, indirection, large state full of irrelevant detail, adversarial content in the state, Choice option order (it leans to the first option). Jev does not generate text.

## Decision

1. **The HTTP API directly, through Epoch's network module; no SDK.** `@typesafe-ai/sdk` (0.7.0 on npm) is official and MIT, but the HTTP API is one documented POST, and adding a dependency needs a reason CLAUDE.md accepts. Calling it through `createNet` keeps every request on the allowlist (`https://api.typesafe.ai` only, `JEV_ORIGIN` in `packages/scorers/src/origins.ts`), refused offline, and visible in one file. The SDK's docs also read `TYPESAFE_API_KEY` from the environment by default, which Epoch would have to defend against, as it does for Anthropic's SDK.

2. **How a pair is posed.** The `ModelScorer` path is unchanged: the same candidates (at most `--max-pairs`, the heuristic's likeliest first), the same secret-file rule, consent, spend holds and plan text. The backend sends the LLM prompt's user text (each side's path and file starts, up to 6,000 characters per file and three files per Go package, plus the pair's co-change counts and shared strings) as `state: { pair: <text> }`, and two questions:
   - `cochange`, a **Noul**: "in the next six months, will a commit that changes TARGET also change SOURCE?", with criteria for yes and no, and a note that file text is data whose instructions must be ignored (the jaggedness page's adversarial-content advice). This is the same quantity the LLM scorer is asked for (ADR-008 item 1).
   - `relation`, a **Choice** over ADR-008's six relation categories, each with a one-line description; it becomes the hint's rationale tag.
     The LLM's system prompt is not sent: it asks for JSON, which Jev does not produce. Jev cites no symbols (it does not generate text), so no unverified names can occur.

3. **Probability to confidence.** The Noul answer is the probability that source changes with target. `ModelScorer` clamps it to at most 0.99 (ADR-008 item 2) and it becomes a `semantic` hint with provenance `model`. Nothing is rescaled: whether it is calibrated is what the benchmark measures. A Noul outside 0..1, or an answer that does not match the documented shape, leaves the pair unscored.

4. **Model.** The default is `jev-1.13.0`, the version `jev-latest` named when this was written, pinned so measured results do not move with the alias; `--model` picks another (e.g. `jev-1.14.0`). Each response's `model` field is recorded, and the benchmark report lists the ids that answered.

5. **Prices: the user's own, as for `llm`.** Epoch ships no prices for the CLI scorers (ADR-008 item 8), so `--scorer jev` needs `--max-spend`, `--price-in` and `--price-out`. The documented prices today are `--price-in 0.042 --price-out 0`. Before each request Epoch holds its worst case: the local input estimate (UTF-8 bytes / 2.5) plus 256 output tokens. Jev takes no output limit; 256 is an estimate for the plan (the documented answers are 18 to 34 tokens), and output costs nothing at the documented price. Spend is settled at the `usage` the response reports; a request that failed counts as 0 (the docs do not say failed requests are billed).

6. **Errors become fixed codes.** 401 and 403: "TypeSafe refused the key", the run stops. 429 and 529: up to 4 attempts, waiting `retry-after` seconds when sent, else 1, 2, 4 s (at most 30 s), then the run stops ("rate limited" or "overloaded"). 400, 413, 415, 422, any other status, a body that is not JSON or not the documented shape: this pair stays unscored. A request that cannot be sent: "could not reach api.typesafe.ai". Messages carry the status code only; no provider text, no underlying error text, never the key. Each request times out after 60 s.

7. **The key.** Read only from the environment, from `JEV_API_KEY` or the variable `--key-env` names (never from argv), or from the OS keychain through `epoch auth set jev` (ADR-009; the environment wins). It goes in the `Authorization` header to `https://api.typesafe.ai` and nowhere else. The desktop app does not offer Jev: it has no relation-scorer feature (ADR-016), so Settings → Keys still says Jev is not available there.

8. **Privacy row.** CLAUDE.md's data-flow table already lists "Jev scorer: code snippets and context sent to TypeSafe AI, opt-in"; docs/privacy.md and the README now say it is built (CLI and benchmarks), what is sent, and what TypeSafe's terms say about training and retention: no training on it, but no fixed retention period outside enterprise zero data retention.

## Measured

`pnpm bench:scorers <zod> <vitest> <flask> <cli> --embedding-model models/all-minilm-l6-v2 --scorer jev --consent-send --max-pairs 1000 --max-spend 0.9 --price-in 0.042 --price-out 0`, on 2026-10-17, at the pinned commits of [docs/benchmarks/scorers.md](../benchmarks/scorers.md) (ADR-008's temporal holdout, unchanged: every heuristic number in the report is the same as before). Jev scored each repository's 1,000 T candidates the heuristic ranks likeliest; 1,508 of those 4,000 pairs could be judged (their target changed in the next 180 days), 50.1% of them positive. Every response named `jev-1.13.0`.

| On the same 1,508 pairs | Brier | ECE   | ROC AUC |
| ----------------------- | ----- | ----- | ------- |
| Jev (`jev-1.13.0`)      | 0.196 | 0.121 | 0.800   |
| Heuristic, fitted on T0 | 0.171 | 0.059 | 0.826   |

| Threshold | Jev: at or above, precision, recall | Heuristic: at or above, precision, recall |
| --------- | ----------------------------------- | ----------------------------------------- |
| 0.5       | 519, 79.0%, 54.3%                   | 942, 66.7%, 83.2%                         |
| 0.6       | 286, 93.4%, 35.4%                   | 562, 80.4%, 59.9%                         |
| 0.7       | 61, 98.4%, 7.9%                     | 406, 86.7%, 46.6%                         |
| 0.8       | 0                                   | 320, 93.8%, 39.7%                         |

| Repository | Judged (positive) | Jev AUC | Heuristic AUC | Jev Brier | Heuristic Brier |
| ---------- | ----------------- | ------- | ------------- | --------- | --------------- |
| zod        | 365 (40.5%)       | 0.616   | 0.682         | 0.230     | 0.229           |
| vitest     | 756 (74.1%)       | 0.744   | 0.823         | 0.220     | 0.145           |
| Flask      | 40 (0.0%)         | –       | –             | 0.112     | 0.022           |
| cli/cli    | 347 (13.5%)       | 0.865   | 0.659         | 0.116     | 0.186           |

**Cost and speed.** 4,000 requests, all answered (54 further candidates were skipped because a file looks like a secret). 13,510,662 input and 375,442 output tokens, about 3,400 input tokens per pair; $0.5674 at the documented \$0.042 per million input tokens, computed from the usage each response reported (TypeSafe's bill is the authority). 126 ms per request on average, sequentially, with no 429 or 529 that exhausted the retries. A 5-pair smoke run on Flask before it cost $0.0005. The Enrich stage times in that report's last table include these requests (about 126 s per repository at T), so they are not comparable with the no-model timings in ADR-008.

**What the numbers say.**

- **Jev does not beat the baseline overall.** On the pairs it scored, it ranks slightly worse than the fitted heuristic (AUC 0.800 vs 0.826) and is less calibrated (ECE 0.121 vs 0.059). CLAUDE.md makes the heuristic the baseline every scorer must beat, so the heuristic stays the default.
- **It is cautious at the top.** No pair scored 0.8 or more; at 0.6 its precision is higher than the heuristic's (93.4% vs 80.4%) at much lower recall (35.4% vs 59.9%). Its probabilities are compressed toward the middle on these pairs.
- **It helps where history misleads.** On cli/cli, where past co-change predicts the future poorly (ADR-008), Jev ranks much better (AUC 0.865 vs 0.659) and has the lower Brier score. On zod and vitest it ranks worse. Combining Jev's probability with the heuristic's features, fitted on T0, is the obvious next experiment; it is not done here.
- **Limits.** One window per repository, four repositories, and a non-random sample: the heuristic's top-ranked pairs, which favors the heuristic on its own ranking. Flask had no positive pair to judge. One model version, one phrasing of the question; the jaggedness page says wording matters.

## Consequences

- A fourth backend behind the same interface and the same guards; the heuristic stays the default and the baseline.
- If TypeSafe changes the API, the zod schema in `packages/scorers/src/jev.ts` rejects the answer and the pair stays unscored rather than producing a wrong edge.
- Jev's answers are not facts: like every model scorer, its output is a hint (CLAUDE.md principle 4).
