# ADR-019: OpenAI and Gemini as summary providers

- **Status:** Accepted (built 2026-10-17; not yet measured with a key)
- **Date:** 2026-10-17
- **Milestone:** M7 (extends ADR-016)

## Context

The app's summaries could come from Anthropic (with the user's key) or a model on this machine (Ollama). The maintainer asked for OpenAI and Gemini as well. CLAUDE.md already describes the LLM key as "Anthropic first, behind a provider-agnostic interface", and the data-flow row says only "the model provider". So this extends ADR-016 rather than changing a contract. Scope is summaries only: the CLI's `--scorer llm` stays Anthropic-only.

## Sources (read 2026-10-17)

Every API detail, model id and price below comes from these pages.

- OpenAI Responses API: https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI models and GPT-6 Luna: https://developers.openai.com/api/docs/models, https://developers.openai.com/api/docs/models/gpt-6-luna
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- Gemini `generateContent`: https://ai.google.dev/api/generate-content
- Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
- Gemini models and Gemini 3.1 Flash-Lite: https://ai.google.dev/gemini-api/docs/models, https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- Gemini API keys: https://ai.google.dev/gemini-api/docs/api-key

## Decision

1. **Plain `fetch`, no SDKs.** Both providers are called over their documented REST endpoints through Epoch's network module (`packages/scorers/src/net.ts`), as Jev already is (ADR-017). The offline switch, origin allowlist and abort-in-flight apply unchanged, and there are no new dependencies. The cost is that Epoch maps errors and stop reasons itself (below), and there are no automatic retries. A failed summary is shown as failed and can be asked for again.
2. **The requests.**
   - **OpenAI:** `POST https://api.openai.com/v1/responses` with `instructions` (the system prompt), `input` (the user prompt), `max_output_tokens`, `reasoning: { effort: "low" }` and `store: false`. The key goes as `Authorization: Bearer`.
   - **Gemini:** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` with `systemInstruction`, one user `contents` entry, `generationConfig.maxOutputTokens` and `store: false`. The key goes in the `x-goog-api-key` header, **never in the URL**, although Google's own REST examples put it in a `?key=` query, where it would reach logs and the network module's record of what was sent. No `thinkingConfig` is sent, because the supported levels differ by model; the model's default applies.
   - **Neither provider stores the request:** both get `store: false`. OpenAI otherwise keeps responses for at least 30 days by default; Gemini's flag overrides the project's logging setting.
3. **The 1,024-token cap still bounds the cost.**
   - OpenAI's `max_output_tokens` covers visible and reasoning tokens.
   - Gemini's `max_output_tokens` "applies to the combined total of thinking tokens and output tokens" (thinking guide), and thinking is billed as output.
   - So the worst case each request reserves against the spending cap is unchanged. Usage is recorded as reported. OpenAI's `input_tokens` already includes cached input, and its `output_tokens` includes reasoning. Gemini's output is `candidatesTokenCount + thoughtsTokenCount`.
4. **Stop reasons**, mapped to the existing codes:
   - **OpenAI:** a `refusal` content part, or `incomplete_details.reason: "content_filter"`, is a refusal; `"max_output_tokens"` is cut off; `status: "completed"` is the end; anything else is other.
   - **Gemini:** a `promptFeedback.blockReason`, or a finish reason of `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` or `SPII`, is a refusal; `MAX_TOKENS` is cut off; `STOP` is the end. Thought parts are never kept as text.
   - **HTTP errors** become fixed codes and never carry the provider's text: 401/403 → `auth`, 404 → `no-model`, 400/422 → `bad-request`, 429 → `rate-limited`, other → `server`.
5. **Consent is per provider and project.** Agreeing to send a project to Anthropic does not cover OpenAI or Gemini, because the files would go somewhere else. The native dialog names the provider. For Gemini it also says what Google's pricing page says: on the free tier, content may be used to improve Google's products, and on the paid tier it is not.
6. **Keys, cache and egress.**
   - **Keys:** each provider has its own key in Settings → Keys, stored like Anthropic's (`safeStorage`, ADR-016). A key goes only to its own provider, because each client is built with its own fixed origin.
   - **Cache:** summaries are cached in their own namespace per provider (`summary:openai`, `summary:gemini`), and count as paid in the cache stats.
   - **Egress:** main's egress session and network allowlist add exactly the two origins, compared by origin, and refuse them in offline mode.
7. **Defaults and prices.** Each provider gets a default summary model: the small, low-cost text model its models page recommends for high-volume work. Its price ships, copied from the pricing page with the date read:
   - `gpt-6-luna`: $0.10 / $0.50 per million input / output tokens (standard, prompts under 272K tokens).
   - `gemini-3.1-flash-lite`: $0.25 / $1.50 (paid tier, standard).

   Any other model needs the user's own price, as before. Summary prompts stay far below the long-context thresholds.

8. **The CLI's `epoch auth` stays Anthropic and Jev.** The CLI has no summary command, so it would store OpenAI and Gemini keys that nothing reads. `pnpm bench:summaries` takes `--provider anthropic|openai|gemini`. By default it reads the key from `OPENAI_API_KEY` or `GEMINI_API_KEY` (the variable name Google's docs use), or from whatever `--key-env` names.

## Consequences

- Two more destinations in the data-flow table and in `docs/privacy.md`. Both are opt-in, used only with the user's key, and only for summaries.
- No measured cost yet for the new providers: that needs the maintainer's keys and a run of `pnpm bench:summaries --provider openai|gemini --send`. Until then the only numbers are Epoch's own upper estimates.
- Unit tests cover each request's shape and headers, that the Gemini key never appears in the URL, every stop and error mapping, and offline refusal. `summary-service` tests cover consent per provider and the need for the chosen provider's own key. The e2e stubs still serve only Anthropic and Ollama.
