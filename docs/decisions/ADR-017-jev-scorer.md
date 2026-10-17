# ADR-017: JevScorer, TypeSafe AI's Jev over its HTTP API

- **Status:** Accepted (built 2026-10-17; measured: see "Measured" below)
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

The legal documents it links (typesafe.ai/legal/data-processing, /privacy-policy) are on typesafe.ai, which the build environment cannot reach, so they were not read.

## What the docs say

- **Endpoint.** `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`. The body has `state` (string, object or array), `model`, and `questions`, a map of ids you choose to typed questions. The answers come back under the same ids, with `model` (the versioned id that answered) and `usage` (`input_tokens`, `output_tokens`).
- **Question types used here.** `noul`: a yes/no question (`instructions`, optional `criteria.true` and `criteria.false`); the answer is `{ type: "noul", noul }`, 0 (no) to 1 (yes). `choice`: one option of a map `criteria` (at most 255); the answer is `{ type: "choice", choice, probabilities, confidence }`.
- **Request rules.** At most 32 MiB, UTF-8 JSON without a BOM, at most 64 nesting levels, finite numbers only. Context: 64k tokens per request and 32k per question, by default.
- **Errors.** 400 (a broken rule; `max_tokens_exceeded` if over the context), 401 (missing or invalid key), 413, 415, 422 (validation), 429 (rate limit), 529 (overloaded). On 429 and 529, retry with exponential backoff; the SDKs follow `retry-after` when sent. Rate limits are per organization, in tokens and requests per second.
- **Models and price.** `jev-1.14.0` (from 2026-10-14) and `jev-1.13.0`, both \$0.042 per million input tokens; "Output tokens are free." `jev-latest` points to `jev-1.13.0` and `jev-preview` to `jev-1.14.0`; aliases move, so the docs advise sending a versioned id once thresholds are tuned against it.
- **Data handling.** "Jev is not trained on customer requests or responses." Zero data retention is offered to enterprise customers only; retention otherwise is governed by the Data Processing Agreement (not read, see above).
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

8. **Privacy row.** CLAUDE.md's data-flow table already lists "Jev scorer: code snippets and context sent to TypeSafe AI, opt-in"; docs/privacy.md and the README now say it is built (CLI and benchmarks), what is sent, and what the docs say about training and retention.

## Measured

Filled from `pnpm bench:scorers ... --scorer jev` (docs/benchmarks/scorers.md); see the next section.

## Consequences

- A fourth backend behind the same interface and the same guards; the heuristic stays the default and the baseline.
- If TypeSafe changes the API, the zod schema in `packages/scorers/src/jev.ts` rejects the answer and the pair stays unscored rather than producing a wrong edge.
- Jev's answers are not facts: like every model scorer, its output is a hint (CLAUDE.md principle 4).
