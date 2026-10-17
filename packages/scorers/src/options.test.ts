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

describe("resolveModel --scorer jev", () => {
  const paid = {
    scorer: "jev",
    "max-spend": "1",
    "price-in": "0.042",
    "price-out": "0",
  } as const;

  it("reads the key from JEV_API_KEY, or the variable --key-env names, never another provider's", () => {
    const model = resolveModel(values(paid), { JEV_API_KEY: "j" });
    expect(model?.backend.id).toBe("jev:jev-1.13.0");
    expect(model?.backend.destination).toBe("https://api.typesafe.ai");
    expect(model?.spend?.capUsd).toBe(1);
    expect(() =>
      resolveModel(values(paid), { ANTHROPIC_API_KEY: "a" }),
    ).toThrow(/needs your own Jev key: set JEV_API_KEY/);
    expect(
      resolveModel(values({ ...paid, "key-env": "MY_JEV" }), { MY_JEV: "j" })
        ?.backend.id,
    ).toBe("jev:jev-1.13.0");
    expect(() =>
      resolveModel(values({ ...paid, "key-env": "my jev" }), {}),
    ).toThrow(/--key-env must be an environment variable name/);
  });

  it("needs a spend cap and prices, like llm", () => {
    expect(() =>
      resolveModel(values({ scorer: "jev", "max-spend": "1" }), {
        JEV_API_KEY: "j",
      }),
    ).toThrow(/--price-in and --price-out/);
  });

  it("is refused offline, naming where it would send", () => {
    expect(() =>
      resolveModel(values(paid), { JEV_API_KEY: "j" }, { offline: true }),
    ).toThrow(/--offline.*api\.typesafe\.ai/);
  });

  it("sends only to TypeSafe's API", async () => {
    const urls: string[] = [];
    const model = resolveModel(
      values(paid),
      { JEV_API_KEY: "j" },
      {
        fetch: (input) => {
          urls.push(
            input instanceof Request
              ? input.url
              : input instanceof URL
                ? input.href
                : input,
          );
          return Promise.resolve(new Response("{}", { status: 500 }));
        },
      },
    );
    await model?.backend.judge({ system: "s", user: "u" });
    expect(urls).toEqual(["https://api.typesafe.ai/v1/systemone"]);
  });

  it("rejects --key-env for the heuristic", () => {
    expect(() => resolveModel(values({ "key-env": "X" }), {})).toThrow(
      /apply to --scorer local, llm or jev/,
    );
  });
});
