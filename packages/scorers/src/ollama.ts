import { z } from "zod";
import {
  BackendFatal,
  Verdict,
  type ModelBackend,
  type Prompt,
} from "./model.js";
import { NetworkBlockedError, type Net } from "./net.js";
import { OLLAMA_ORIGIN } from "./origins.js";

export { OLLAMA_ORIGIN };

/*
 * LocalScorer's backend: an Ollama server on this machine (nothing leaves
 * it). POST /api/chat with `stream: false` and a JSON schema in `format`
 * (structured outputs), per Ollama's API docs at v0.40.5
 * (https://github.com/ollama/ollama/blob/v0.40.5/docs/api.md). Token counts
 * come from `prompt_eval_count` and `eval_count`.
 */

const ChatResponse = z.object({
  message: z.object({ content: z.string() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

const VERDICT_SCHEMA = z.toJSONSchema(Verdict);

export function ollamaBackend(opts: {
  readonly model: string;
  readonly net: Net;
}): ModelBackend {
  return {
    id: `local:${opts.model}`,
    provider: `Ollama on this machine (model ${opts.model})`,
    destination: OLLAMA_ORIGIN,
    remote: false,
    maxOutputTokens: 256,
    async judge(prompt: Prompt) {
      let res: Response;
      try {
        res = await opts.net.fetch(`${OLLAMA_ORIGIN}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: opts.model,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            stream: false,
            format: VERDICT_SCHEMA,
            options: { temperature: 0 },
          }),
        });
      } catch (err) {
        if (err instanceof NetworkBlockedError)
          throw new BackendFatal(err.message);
        throw new BackendFatal(
          `could not reach Ollama at ${OLLAMA_ORIGIN}: is it running? (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      if (res.status === 404) {
        throw new BackendFatal(
          `Ollama has no model "${opts.model}" (pull it first)`,
        );
      }
      const none = { inputTokens: 0, outputTokens: 0 };
      if (!res.ok) return { verdict: null, usage: none };
      const parsed = ChatResponse.safeParse(await res.json());
      if (!parsed.success) return { verdict: null, usage: none };
      const usage = {
        inputTokens: parsed.data.prompt_eval_count ?? 0,
        outputTokens: parsed.data.eval_count ?? 0,
      };
      let json: unknown;
      try {
        json = JSON.parse(parsed.data.message.content);
      } catch {
        return { verdict: null, usage };
      }
      const verdict = Verdict.safeParse(json);
      return { verdict: verdict.success ? verdict.data : null, usage };
    },
  };
}
