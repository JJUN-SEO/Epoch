import { describe, expect, it } from "vitest";
import { ANTHROPIC_ORIGIN } from "./anthropic.js";
import { createNet } from "./net.js";
import { OLLAMA_ORIGIN } from "./ollama.js";
import { GEMINI_ORIGIN, OPENAI_ORIGIN } from "./origins.js";
import {
  TextModelError,
  anthropicTextModel,
  geminiTextModel,
  ollamaTextModel,
  openaiTextModel,
  type TextModel,
} from "./text-model.js";

/*
 * Plain-text generation for summaries (M7), through Epoch's network module
 * only. Anthropic through the SDK; OpenAI, Gemini and Ollama by their
 * documented HTTP APIs; all against fake fetches here.
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

  it("names a key that belongs to no workspace, which Anthropic refuses with a 400", async () => {
    // The API's answer, as a maintainer's key received it on 2026-10-17.
    const { model } = anthropic(() =>
      json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.",
          },
        },
        400,
      ),
    );
    const err = await model
      .generate({ system: "", user: "u", maxOutputTokens: 10 })
      .catch((e: unknown) => e);
    expect((err as TextModelError).code).toBe("key-needs-workspace");
    expect((err as Error).message).toBe(
      "the key belongs to no workspace: create one inside a workspace in the Claude Console",
    );
  });

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

const generateErr = (model: TextModel, signal?: AbortSignal) =>
  model
    .generate({
      system: "",
      user: "u",
      maxOutputTokens: 10,
      ...(signal ? { signal } : {}),
    })
    .catch((e: unknown) => e);

const openaiResponse = (over: Record<string, unknown> = {}) =>
  json({
    id: "resp_test",
    object: "response",
    status: "completed",
    incomplete_details: null,
    output: [
      { type: "reasoning", id: "rs_test", summary: [] },
      {
        type: "message",
        id: "msg_test",
        status: "completed",
        role: "assistant",
        content: [
          { type: "output_text", text: "Starts ", annotations: [] },
          { type: "output_text", text: "the server.", annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
      output_tokens: 90,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 1090,
    },
    ...over,
  });

const openai = (
  respond: (seen: Seen) => Response | Promise<Response>,
  offline = false,
): { model: TextModel; seen: Seen[] } => {
  const r = recorder(respond);
  return {
    seen: r.seen,
    model: openaiTextModel({
      apiKey: "test-key",
      model: "gpt-6-luna",
      net: createNet({ offline, allow: [OPENAI_ORIGIN], fetch: r.fetch }),
    }),
  };
};

describe("openaiTextModel", () => {
  it("sends one Responses request at low effort, unstored, with the key only to api.openai.com", async () => {
    const { model, seen } = openai(() => openaiResponse());
    const out = await model.generate({
      system: "sys",
      user: "usr",
      maxOutputTokens: 1024,
    });
    expect(out).toEqual({
      text: "Starts the server.",
      stop: "end",
      usage: { inputTokens: 1000, outputTokens: 90 },
    });
    expect(model).toMatchObject({
      provider: "openai",
      model: "gpt-6-luna",
      destination: OPENAI_ORIGIN,
      remote: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${OPENAI_ORIGIN}/v1/responses`);
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer test-key");
    expect(seen[0]?.headers.get("x-api-key")).toBeNull();
    expect(seen[0]?.body).toEqual({
      model: "gpt-6-luna",
      instructions: "sys",
      input: "usr",
      max_output_tokens: 1024,
      reasoning: { effort: "low" },
      store: false,
    });
  });

  it.each([
    [
      {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
      "max-tokens",
    ],
    [
      {
        status: "incomplete",
        incomplete_details: { reason: "content_filter" },
      },
      "refusal",
    ],
    [{ status: "failed" }, "other"],
  ])("reports %j as %s", async (over, stop) => {
    const { model } = openai(() => openaiResponse(over));
    const out = await model.generate({
      system: "",
      user: "u",
      maxOutputTokens: 10,
    });
    expect(out.stop).toBe(stop);
  });

  it("calls a refusal part a refusal", async () => {
    const { model } = openai(() =>
      openaiResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "refusal", refusal: "I can't help with that." }],
          },
        ],
      }),
    );
    const out = await model.generate({
      system: "",
      user: "u",
      maxOutputTokens: 10,
    });
    expect(out).toMatchObject({ text: "", stop: "refusal" });
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [404, "no-model"],
    [429, "rate-limited"],
    [400, "bad-request"],
    [500, "server"],
  ])(
    "turns HTTP %i into the reason %s, without the provider's text",
    async (status, code) => {
      const { model } = openai(() =>
        json(
          {
            error: {
              message: "Incorrect API key provided: test-key",
              type: "x",
            },
          },
          status,
        ),
      );
      const err = await generateErr(model);
      expect(err).toBeInstanceOf(TextModelError);
      expect((err as TextModelError).code).toBe(code);
      expect((err as Error).message).not.toContain("test-key");
    },
  );

  it("calls an answer it cannot read a bad response", async () => {
    const { model } = openai(() => json({ unexpected: true }));
    expect(((await generateErr(model)) as TextModelError).code).toBe(
      "bad-response",
    );
  });

  it("sends nothing offline", async () => {
    const { model, seen } = openai(() => openaiResponse(), true);
    expect(((await generateErr(model)) as TextModelError).code).toBe("offline");
    expect(seen).toEqual([]);
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    const { model } = openai(
      (s) =>
        new Promise<Response>((_, reject) => {
          s.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
          controller.abort();
        }),
    );
    expect(
      ((await generateErr(model, controller.signal)) as TextModelError).code,
    ).toBe("aborted");
  });
});

const geminiResponse = (over: Record<string, unknown> = {}) =>
  json({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            { text: "thinking about it", thought: true },
            { text: "Starts " },
            { text: "the server." },
          ],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 1000,
      candidatesTokenCount: 60,
      thoughtsTokenCount: 40,
      totalTokenCount: 1100,
    },
    ...over,
  });

const gemini = (
  respond: (seen: Seen) => Response | Promise<Response>,
  offline = false,
): { model: TextModel; seen: Seen[] } => {
  const r = recorder(respond);
  return {
    seen: r.seen,
    model: geminiTextModel({
      apiKey: "test-key",
      model: "gemini-3.1-flash-lite",
      net: createNet({ offline, allow: [GEMINI_ORIGIN], fetch: r.fetch }),
    }),
  };
};

describe("geminiTextModel", () => {
  it("sends one generateContent request, unstored, with the key in a header and never in the URL", async () => {
    const { model, seen } = gemini(() => geminiResponse());
    const out = await model.generate({
      system: "sys",
      user: "usr",
      maxOutputTokens: 1024,
    });
    expect(out).toEqual({
      text: "Starts the server.",
      stop: "end",
      // Thinking is billed as output.
      usage: { inputTokens: 1000, outputTokens: 100 },
    });
    expect(model).toMatchObject({
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      destination: GEMINI_ORIGIN,
      remote: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      `${GEMINI_ORIGIN}/v1beta/models/gemini-3.1-flash-lite:generateContent`,
    );
    expect(seen[0]?.url).not.toContain("test-key");
    expect(seen[0]?.headers.get("x-goog-api-key")).toBe("test-key");
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[0]?.body).toEqual({
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "usr" }] }],
      generationConfig: { maxOutputTokens: 1024 },
      store: false,
    });
  });

  it.each([
    ["MAX_TOKENS", "max-tokens"],
    ["SAFETY", "refusal"],
    ["PROHIBITED_CONTENT", "refusal"],
    ["OTHER", "other"],
  ])("reports finish reason %s as %s", async (finishReason, stop) => {
    const { model } = gemini(() =>
      geminiResponse({
        candidates: [{ content: { parts: [{ text: "x" }] }, finishReason }],
      }),
    );
    const out = await model.generate({
      system: "",
      user: "u",
      maxOutputTokens: 10,
    });
    expect(out.stop).toBe(stop);
  });

  it("calls a blocked prompt a refusal", async () => {
    const { model } = gemini(() =>
      json({
        promptFeedback: { blockReason: "SAFETY" },
        usageMetadata: { promptTokenCount: 12 },
      }),
    );
    const out = await model.generate({
      system: "",
      user: "u",
      maxOutputTokens: 10,
    });
    expect(out).toEqual({
      text: "",
      stop: "refusal",
      usage: { inputTokens: 12, outputTokens: 0 },
    });
  });

  it.each([
    [400, "bad-request"],
    [403, "auth"],
    [404, "no-model"],
    [429, "rate-limited"],
    [503, "server"],
  ])(
    "turns HTTP %i into the reason %s, without the provider's text",
    async (status, code) => {
      const { model } = gemini(() =>
        json(
          {
            error: { code: status, message: "API key not valid", status: "X" },
          },
          status,
        ),
      );
      const err = await generateErr(model);
      expect((err as TextModelError).code).toBe(code);
      expect((err as Error).message).not.toContain("API key not valid");
    },
  );

  it("sends nothing offline", async () => {
    const { model, seen } = gemini(() => geminiResponse(), true);
    expect(((await generateErr(model)) as TextModelError).code).toBe("offline");
    expect(seen).toEqual([]);
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
