import { describe, expect, it } from "vitest";
import { OLLAMA_ORIGIN } from "./ollama.js";
import {
  ScorerUsageError,
  resolveModel,
  type ScorerValues,
} from "./options.js";

const values = (over: Partial<ScorerValues>): ScorerValues => ({
  scorer: "heuristic",
  "consent-send": false,
  ...over,
});

describe("resolveModel offline", () => {
  it("refuses the remote scorer, naming where it would send", () => {
    expect(() =>
      resolveModel(
        values({
          scorer: "llm",
          "max-spend": "1",
          "price-in": "1",
          "price-out": "5",
        }),
        { ANTHROPIC_API_KEY: "k" },
        { offline: true },
      ),
    ).toThrow(/--offline.*api\.anthropic\.com/);
    expect(() =>
      resolveModel(values({ scorer: "llm" }), {}, { offline: true }),
    ).toThrow(ScorerUsageError);
  });

  it("keeps a local model on this machine", async () => {
    const urls: string[] = [];
    const model = resolveModel(
      values({ scorer: "local", model: "llama3.1" }),
      {},
      {
        offline: true,
        fetch: (input) => {
          urls.push(
            input instanceof Request
              ? input.url
              : input instanceof URL
                ? input.href
                : input,
          );
          return Promise.resolve(
            new Response(
              JSON.stringify({
                message: {
                  role: "assistant",
                  content:
                    '{"probability":0.3,"relation":"unclear","symbols":[]}',
                },
                done: true,
                prompt_eval_count: 1,
                eval_count: 1,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        },
      },
    );
    await model?.backend.judge({ system: "s", user: "u" });
    expect(urls).toEqual([`${OLLAMA_ORIGIN}/api/chat`]);
  });
});
