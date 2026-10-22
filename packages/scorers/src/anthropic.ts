import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { DEFAULT_CLAUDE_MODEL } from "@epoch-dev/core";
import {
  BackendFatal,
  Verdict,
  type ModelBackend,
  type Prompt,
} from "./model.js";
import { NetworkBlockedError, type Net } from "./net.js";
import { ANTHROPIC_ORIGIN } from "./origins.js";

export { ANTHROPIC_ORIGIN };

/*
 * LlmScorer's backend: Claude through the official TypeScript SDK
 * (@anthropic-ai/sdk 0.129.0), with structured outputs
 * (`messages.parse` + `output_config.format`) and low effort for a short
 * judgment. The user's own key goes only to api.anthropic.com: the base URL
 * is fixed (not read from ANTHROPIC_BASE_URL), nothing else is taken from
 * the environment (anthropicClient), and every request goes through Epoch's
 * network module, the SDK's `fetch`. The default model is
 * the current small Claude model (CLAUDE.md: "a small cheap Claude model");
 * --model picks another.
 */

/** One default for the scorer and the app's summaries (core settings). */
export const DEFAULT_LLM_MODEL = DEFAULT_CLAUDE_MODEL;

const blocked = (err: unknown): boolean =>
  err instanceof NetworkBlockedError ||
  (err instanceof Error && err.cause instanceof NetworkBlockedError);

/** Silences the SDK's logger; its debug level would print request bodies. */
const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * An SDK client that takes nothing from the environment (SDK 0.129.0,
 * client.js): only the given key (`authToken: null`, or it would also send
 * ANTHROPIC_AUTH_TOKEN as a bearer token), the fixed host, no logging
 * (ANTHROPIC_LOG=debug would print request bodies, which hold source code),
 * and none of ANTHROPIC_CUSTOM_HEADERS, which the constructor always reads:
 * it is set aside while the client is made (synchronously) and put back.
 */
export function anthropicClient(opts: {
  readonly apiKey: string;
  readonly net: Net;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}): Anthropic {
  const headers = process.env.ANTHROPIC_CUSTOM_HEADERS;
  Reflect.deleteProperty(process.env, "ANTHROPIC_CUSTOM_HEADERS");
  try {
    return new Anthropic({
      apiKey: opts.apiKey,
      authToken: null,
      baseURL: ANTHROPIC_ORIGIN,
      fetch: opts.net.fetch,
      maxRetries: opts.maxRetries ?? 2,
      ...(opts.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
      logLevel: "off",
      logger: silent,
    });
  } finally {
    if (headers !== undefined) process.env.ANTHROPIC_CUSTOM_HEADERS = headers;
  }
}

export function anthropicBackend(opts: {
  readonly apiKey: string;
  readonly model: string;
  readonly net: Net;
  readonly maxOutputTokens?: number;
}): ModelBackend {
  const client = anthropicClient({ apiKey: opts.apiKey, net: opts.net });
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
