import { describe, expect, it } from "vitest";
import { ANTHROPIC_ORIGIN } from "./anthropic.js";
import { createNet } from "./net.js";
import { OLLAMA_ORIGIN } from "./ollama.js";
import {
  TextModelError,
  anthropicTextModel,
  ollamaTextModel,
  type TextModel,
} from "./text-model.js";

/*
 * Plain-text generation for summaries (M7), through Epoch's network module
 * only. Anthropic through the SDK, Ollama by its documented HTTP API; both
 * against fake fetches here.
 */

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

function recorder(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      url:
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      headers: new Headers(init?.headers),
      body: JSON.parse(
        typeof init?.body === "string" ? init.body : "{}",
      ) as Record<string, unknown>,
      signal: init?.signal,
    };
    seen.push(s);
    return Promise.resolve(respond(s));
  };
  return { seen, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const message = (
  stop: string,
  content: unknown[] = [{ type: "text", text: "Starts the server." }],
) =>
  json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 900,
      output_tokens: 60,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: null,
    },
  });

const anthropic = (
  respond: (seen: Seen) => Response | Promise<Response>,
  offline = false,
): { model: TextModel; seen: Seen[] } => {
  const r = recorder(respond);
  return {
    seen: r.seen,
    model: anthropicTextModel({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
      net: createNet({ offline, allow: [ANTHROPIC_ORIGIN], fetch: r.fetch }),
      maxRetries: 0,
    }),
  };
};

describe("anthropicTextModel", () => {
  it("sends one plain request at low effort, with the key only to api.anthropic.com", async () => {
    const { model, seen } = anthropic(() =>
      message("end_turn", [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "Starts " },
        { type: "text", text: "the server." },
      ]),
    );
    const out = await model.generate({
      system: "sys",
      user: "usr",
      maxOutputTokens: 1024,
    });
    expect(out).toEqual({
      text: "Starts the server.",
      stop: "end",
      usage: { inputTokens: 1000, outputTokens: 60 },
    });
    expect(model).toMatchObject({
      provider: "anthropic",
      model: "claude-haiku-5-5",
      destination: ANTHROPIC_ORIGIN,
      remote: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${ANTHROPIC_ORIGIN}/v1/messages`);
    expect(seen[0]?.headers.get("x-api-key")).toBe("test-key");
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[0]?.body).toEqual({
      model: "claude-haiku-5-5",
      max_tokens: 1024,
      system: "sys",
      messages: [{ role: "user", content: "usr" }],
      output_config: { effort: "low" },
    });
  });

  it.each([
    ["max_tokens", "max-tokens"],
    ["refusal", "refusal"],
    ["pause_turn", "other"],
  ])("reports stop reason %s as %s", async (reason, stop) => {
    const { model } = anthropic(() => message(reason));
    const out = await model.generate({
      system: "",
      user: "u",
      maxOutputTokens: 10,
    });
    expect(out.stop).toBe(stop);
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate-limited"],
    [400, "bad-request"],
    [500, "server"],
  ])(
    "turns HTTP %i into the reason %s, without the key",
    async (status, code) => {
      const { model } = anthropic(() =>
        json({ type: "error", error: { type: "x", message: "nope" } }, status),
      );
      const err = await model
        .generate({ system: "", user: "u", maxOutputTokens: 10 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TextModelError);
      expect((err as TextModelError).code).toBe(code);
      expect((err as Error).message).not.toContain("test-key");
    },
  );

  it("sends nothing offline", async () => {
    const { model, seen } = anthropic(() => message("end_turn"), true);
    const err = await model
      .generate({ system: "", user: "u", maxOutputTokens: 10 })
      .catch((e: unknown) => e);
    expect((err as TextModelError).code).toBe("offline");
    expect(seen).toEqual([]);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const { model, seen } = anthropic(
      (s) =>
        new Promise<Response>((_, reject) => {
          s.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          controller.abort();
        }),
    );
    const err = await model
      .generate({
        system: "",
        user: "u",
        maxOutputTokens: 10,
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    expect((err as TextModelError).code).toBe("aborted");
    expect(seen).toHaveLength(1);
  });
});

describe("ollamaTextModel", () => {
  const ollama = (respond: (seen: Seen) => Response | Promise<Response>) => {
    const r = recorder(respond);
    return {
      seen: r.seen,
      model: ollamaTextModel({
        model: "qwen3:4b",
        net: createNet({
          offline: true,
          allow: [OLLAMA_ORIGIN],
          offlineAllow: [OLLAMA_ORIGIN],
          fetch: r.fetch,
        }),
      }),
    };
  };

  it("asks the model on this machine, even offline, and reads its counts", async () => {
    const { model, seen } = ollama(() =>
      json({
        message: { role: "assistant", content: "Starts the server." },
        done_reason: "stop",
        prompt_eval_count: 300,
        eval_count: 20,
      }),
    );
    const out = await model.generate({
      system: "sys",
      user: "usr",
      maxOutputTokens: 512,
    });
    expect(out).toEqual({
      text: "Starts the server.",
      stop: "end",
      usage: { inputTokens: 300, outputTokens: 20 },
    });
    expect(model).toMatchObject({
      provider: "local",
      model: "qwen3:4b",
      remote: false,
    });
    expect(seen[0]?.url).toBe(`${OLLAMA_ORIGIN}/api/chat`);
    expect(seen[0]?.body).toEqual({
      model: "qwen3:4b",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      stream: false,
      options: { num_predict: 512 },
    });
  });

  it("calls an answer that used every token cut off", async () => {
    const { model } = ollama(() =>
      json({ message: { content: "Starts" }, eval_count: 512 }),
    );
    const out = await model.generate({
      system: "",
      user: "u",
      maxOutputTokens: 512,
    });
    expect(out.stop).toBe("max-tokens");
  });

  it("says when the model is missing or Ollama is not running", async () => {
    let err = await ollama(() => json({ error: "model not found" }, 404))
      .model.generate({ system: "", user: "u", maxOutputTokens: 1 })
      .catch((e: unknown) => e);
    expect((err as TextModelError).code).toBe("no-model");
    err = await ollama(() => Promise.reject(new TypeError("fetch failed")))
      .model.generate({ system: "", user: "u", maxOutputTokens: 1 })
      .catch((e: unknown) => e);
    expect((err as TextModelError).code).toBe("unreachable");
  });
});
