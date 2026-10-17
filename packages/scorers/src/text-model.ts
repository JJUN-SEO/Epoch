import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { ANTHROPIC_ORIGIN, anthropicClient } from "./anthropic.js";
import { NetworkBlockedError, type Net } from "./net.js";
import { OLLAMA_ORIGIN } from "./ollama.js";

/*
 * Plain-text generation for summaries (M7; CLAUDE.md RelationScorer: prose
 * summaries use a regular text LLM or a local model, never Jev). Every
 * request goes through Epoch's network module.
 *
 * Anthropic: the Messages API through the SDK (0.129.0), as documented in
 * the claude-api reference: `system`, one user message, `max_tokens`, and
 * `output_config.effort: "low"` as the M6 scorer sends. No sampling
 * parameters (the current models reject non-default ones) and no
 * `thinking` field (whether it may be disabled differs by model; low
 * effort keeps it short). Stop reasons: end_turn, max_tokens, refusal.
 *
 * Ollama: POST /api/chat with `stream: false` and `options.num_predict`,
 * per its API docs at v0.40.5
 * (https://github.com/ollama/ollama/blob/v0.40.5/docs/api.md); token
 * counts from `prompt_eval_count` and `eval_count`.
 */

export interface TextRequest {
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

/** end: finished; max-tokens: cut off; refusal: declined (Anthropic's safety classifiers). */
export type TextStop = "end" | "max-tokens" | "refusal" | "other";

export interface TextResult {
  readonly text: string;
  readonly stop: TextStop;
  /** As the provider reported them; input includes cached input. */
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
}

export interface TextModel {
  readonly provider: "anthropic" | "local";
  readonly model: string;
  /** The origin requests go to. */
  readonly destination: string;
  /** Leaves this machine. */
  readonly remote: boolean;
  generate(req: TextRequest): Promise<TextResult>;
}

export type TextModelErrorCode =
  | "offline"
  | "blocked"
  | "aborted"
  | "auth"
  | "rate-limited"
  | "bad-request"
  | "key-needs-workspace"
  | "no-model"
  | "server"
  | "unreachable"
  | "bad-response";

const MESSAGES: Record<TextModelErrorCode, string> = {
  offline: "offline mode is on",
  blocked: "not an allowed destination",
  aborted: "cancelled",
  auth: "the provider refused the key",
  "rate-limited": "rate limited by the provider",
  "bad-request": "the provider rejected the request",
  "key-needs-workspace":
    "the key belongs to no workspace: create one inside a workspace in the Claude Console",
  "no-model": "the model is not available",
  server: "the provider had an error",
  unreachable: "could not reach the provider",
  "bad-response": "the provider's answer could not be read",
};

/**
 * A failed generation, as a fixed reason code and a fixed message: never
 * the provider's text, a request option, or a key.
 */
export class TextModelError extends Error {
  readonly code: TextModelErrorCode;
  constructor(code: TextModelErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

function blockedCode(err: unknown): TextModelErrorCode | undefined {
  const blocked =
    err instanceof NetworkBlockedError
      ? err
      : err instanceof Error && err.cause instanceof NetworkBlockedError
        ? err.cause
        : undefined;
  if (!blocked) return undefined;
  return blocked.reason === "offline" ? "offline" : "blocked";
}

function anthropicCode(err: unknown): TextModelErrorCode {
  const blocked = blockedCode(err);
  if (blocked) return blocked;
  if (err instanceof Anthropic.APIUserAbortError) return "aborted";
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  )
    return "auth";
  if (err instanceof Anthropic.RateLimitError) return "rate-limited";
  if (err instanceof Anthropic.NotFoundError) return "no-model";
  if (err instanceof Anthropic.BadRequestError)
    // A key outside any workspace: the API asks for the
    // anthropic-workspace-id header. Matched here; the text is never shown.
    return /anthropic-workspace-id|not scoped to a workspace/i.test(err.message)
      ? "key-needs-workspace"
      : "bad-request";
  if (err instanceof Anthropic.APIConnectionError) return "unreachable";
  return "server";
}

export function anthropicTextModel(opts: {
  readonly apiKey: string;
  readonly model: string;
  readonly net: Net;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}): TextModel {
  const client = anthropicClient({
    apiKey: opts.apiKey,
    net: opts.net,
    ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  return {
    provider: "anthropic",
    model: opts.model,
    destination: ANTHROPIC_ORIGIN,
    remote: true,
    async generate(req) {
      let res: Anthropic.Message;
      try {
        res = await client.messages.create(
          {
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            output_config: { effort: "low" },
          },
          req.signal ? { signal: req.signal } : {},
        );
      } catch (err) {
        throw new TextModelError(anthropicCode(err));
      }
      const u = res.usage;
      return {
        text: res.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join(""),
        stop:
          res.stop_reason === "end_turn"
            ? "end"
            : res.stop_reason === "max_tokens"
              ? "max-tokens"
              : res.stop_reason === "refusal"
                ? "refusal"
                : "other",
        usage: {
          inputTokens:
            u.input_tokens +
            (u.cache_creation_input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens,
        },
      };
    },
  };
}

const ChatResponse = z.object({
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

export function ollamaTextModel(opts: {
  readonly model: string;
  readonly net: Net;
}): TextModel {
  return {
    provider: "local",
    model: opts.model,
    destination: OLLAMA_ORIGIN,
    remote: false,
    async generate(req) {
      let res: Response;
      try {
        res = await opts.net.fetch(`${OLLAMA_ORIGIN}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            stream: false,
            options: { num_predict: req.maxOutputTokens },
          }),
          ...(req.signal ? { signal: req.signal } : {}),
        });
      } catch (err) {
        throw new TextModelError(
          blockedCode(err) ?? (req.signal?.aborted ? "aborted" : "unreachable"),
        );
      }
      if (res.status === 404) throw new TextModelError("no-model");
      if (!res.ok) throw new TextModelError("server");
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new TextModelError("bad-response");
      }
      const parsed = ChatResponse.safeParse(body);
      if (!parsed.success) throw new TextModelError("bad-response");
      const outputTokens = parsed.data.eval_count ?? 0;
      return {
        text: parsed.data.message.content,
        // The docs show done_reason "stop"; an answer that used every
        // allowed token was cut off, whatever else it says.
        stop:
          outputTokens >= req.maxOutputTokens
            ? "max-tokens"
            : parsed.data.done_reason === undefined ||
                parsed.data.done_reason === "stop"
              ? "end"
              : "other",
        usage: {
          inputTokens: parsed.data.prompt_eval_count ?? 0,
          outputTokens,
        },
      };
    },
  };
}
