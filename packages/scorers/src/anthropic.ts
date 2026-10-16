import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  BackendFatal,
  Verdict,
  type ModelBackend,
  type Prompt,
} from "./model.js";
import { NetworkBlockedError, type Net } from "./net.js";

/*
 * LlmScorer's backend: Claude through the official TypeScript SDK
 * (@anthropic-ai/sdk 0.129.0), with structured outputs
 * (`messages.parse` + `output_config.format`) and low effort for a short
 * judgment. The user's own key goes only to api.anthropic.com: the base URL
 * is fixed (not read from ANTHROPIC_BASE_URL), and every request goes
 * through Epoch's network module, the SDK's `fetch`. The default model is
 * the current small Claude model (CLAUDE.md: "a small cheap Claude model");
 * --model picks another.
 */

export const ANTHROPIC_ORIGIN = "https://api.anthropic.com";
export const DEFAULT_LLM_MODEL = "claude-haiku-5-5";

const blocked = (err: unknown): boolean =>
  err instanceof NetworkBlockedError ||
  (err instanceof Error && err.cause instanceof NetworkBlockedError);

export function anthropicBackend(opts: {
  readonly apiKey: string;
  readonly model: string;
  readonly net: Net;
  readonly maxOutputTokens?: number;
}): ModelBackend {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: ANTHROPIC_ORIGIN,
    fetch: opts.net.fetch,
    maxRetries: 2,
  });
  const maxOutputTokens = opts.maxOutputTokens ?? 2048;
  return {
    id: `llm:${opts.model}`,
    provider: `Anthropic (model ${opts.model}, with your key)`,
    destination: ANTHROPIC_ORIGIN,
    remote: true,
    maxOutputTokens,
    async judge(prompt: Prompt) {
      try {
        const res = await client.messages.parse({
          model: opts.model,
          max_tokens: maxOutputTokens,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          output_config: { effort: "low", format: zodOutputFormat(Verdict) },
        });
        const u = res.usage;
        const usage = {
          inputTokens:
            u.input_tokens +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
        };
        // A refusal or a cut-off answer may not match the schema.
        if (res.stop_reason !== "end_turn") return { verdict: null, usage };
        return { verdict: res.parsed_output, usage };
      } catch (err) {
        if (blocked(err)) {
          throw new BackendFatal(
            err instanceof Error ? err.message : String(err),
          );
        }
        if (
          err instanceof Anthropic.AuthenticationError ||
          err instanceof Anthropic.PermissionDeniedError
        ) {
          throw new BackendFatal(`Anthropic refused the key: ${err.message}`);
        }
        if (err instanceof Anthropic.RateLimitError) {
          throw new BackendFatal(`rate limited after retries: ${err.message}`);
        }
        if (err instanceof Anthropic.APIConnectionError) {
          throw new BackendFatal(`could not reach Anthropic: ${err.message}`);
        }
        if (err instanceof Anthropic.APIError) {
          // One bad request (e.g. 400): this pair stays unscored.
          return { verdict: null, usage: { inputTokens: 0, outputTokens: 0 } };
        }
        throw err;
      }
    },
  };
}
