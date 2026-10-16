import { describe, expect, it } from "vitest";
import type { CandidatePair } from "@epoch-dev/core";
import { ANTHROPIC_ORIGIN, anthropicBackend } from "./anthropic.js";
import { SpendCap } from "./cost.js";
import {
  BackendFatal,
  ConsentRequired,
  ModelScorer,
  type ModelBackend,
  type Prompt,
  type ScorerContext,
} from "./model.js";
import { createNet } from "./net.js";
import { OLLAMA_ORIGIN, ollamaBackend } from "./ollama.js";

const TEXT: Record<string, string> = {
  "src/pub.ts":
    'export const EVENT = "user.created";\nexport function publish() {}\n',
  "src/sub.ts":
    'import { EVENT } from "./pub";\nexport function onUserCreated() {}\n',
  "src/other.ts": "export const other = 1;\n",
  ".env": "API_TOKEN=do-not-send\n",
};

const context: ScorerContext = {
  nodeOf: new Map(Object.keys(TEXT).map((p) => [p, p])),
  files: [
    {
      path: "src/pub.ts",
      exports: ["EVENT", "publish"],
      importNames: [],
      strings: ["user.created"],
    },
    {
      path: "src/sub.ts",
      exports: ["onUserCreated"],
      importNames: ["EVENT"],
      strings: [],
    },
    { path: "src/other.ts", exports: ["other"], importNames: [], strings: [] },
    { path: ".env", exports: [], importNames: [], strings: [] },
  ],
};

const pair = (
  source: string,
  target: string,
  together: number,
): CandidatePair => ({
  source,
  target,
  signals: { cochange: { together, sourceCommits: 5, targetCommits: 5 } },
});

const candidates = [
  pair("src/sub.ts", "src/pub.ts", 5), // likeliest by the heuristic
  pair("src/other.ts", "src/pub.ts", 3),
  pair("src/pub.ts", ".env", 5), // involves a secret file
];

/** A remote backend that records prompts and answers with a fixed verdict. */
function fakeRemote(): ModelBackend & { prompts: Prompt[] } {
  const prompts: Prompt[] = [];
  return {
    id: "llm:fake",
    provider: "Fake provider",
    destination: "https://fake.example",
    remote: true,
    maxOutputTokens: 100,
    prompts,
    judge(prompt) {
      prompts.push(prompt);
      return Promise.resolve({
        verdict: {
          probability: 1.4,
          relation: "shared-contract",
          symbols: ["EVENT", "madeUpHelper"],
        },
        usage: { inputTokens: 1000, outputTokens: 50 },
      });
    },
  };
}

const prices = { inputPerMTok: 1, outputPerMTok: 5 };
const readText = (p: string) => TEXT[p];

describe("ModelScorer", () => {
  it("refuses a paid backend without a spend cap", () => {
    expect(
      () =>
        new ModelScorer({
          backend: fakeRemote(),
          readText,
          consent: true,
          maxPairs: 10,
        }),
    ).toThrow("spend cap");
  });

  it("sends nothing before consent, and says exactly what would be sent", async () => {
    const backend = fakeRemote();
    const scorer = new ModelScorer({
      backend,
      readText,
      consent: false,
      maxPairs: 10,
      spend: new SpendCap(1, prices),
    });
    scorer.prepare(context);
    const err = await scorer
      .scoreRelations(candidates)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsentRequired);
    expect(backend.prompts).toEqual([]);
    const text = (err as ConsentRequired).message;
    expect(text).toContain("Fake provider (https://fake.example)");
    expect(text).toContain("src/pub.ts (");
    expect(text).toContain("never sent: 1 files that look like secrets (.env)");
    expect(text).toContain("Nothing has been sent");
    expect((err as ConsentRequired).plan.requests).toBe(2);
  });

  it("with consent: never sends secret files, checks cited symbols, clamps the probability, and stops at the cap", async () => {
    const backend = fakeRemote();
    const shown: string[] = [];
    // One request's worst case: ~estimate input + 100 output tokens at $5/M.
    const scorer = new ModelScorer({
      backend,
      readText,
      consent: true,
      maxPairs: 10,
      spend: new SpendCap(0.0015, prices),
      onPlan: (text) => shown.push(text),
    });
    scorer.prepare(context);
    const scored = await scorer.scoreRelations(candidates);
    expect(shown[0]).toContain("Sending, with your consent");
    expect(backend.prompts.every((p) => !p.user.includes("do-not-send"))).toBe(
      true,
    );
    // The first request spends $0.00125 of the $0.0015 cap; the second
    // could pass it, so it is never sent.
    expect(backend.prompts).toHaveLength(1);
    expect(backend.prompts[0]?.user).toContain("SOURCE: src/sub.ts");
    expect(scored).toEqual([
      {
        source: "src/sub.ts",
        target: "src/pub.ts",
        probability: 0.99,
        rationale: "shared-contract (EVENT)",
      },
    ]);
    expect(scorer.report()).toMatchObject({
      sent: 1,
      scored: 1,
      skippedSecret: 1,
      stoppedAtCap: true,
      unsentAtCap: 1,
      unverifiedSymbols: 1,
    });
    expect(scorer.report().spentUsd).toBeCloseTo(0.00125, 10);
  });

  it("scores at most maxPairs, the heuristic's likeliest first", async () => {
    const backend = fakeRemote();
    const scorer = new ModelScorer({
      backend,
      readText,
      consent: true,
      maxPairs: 1,
      spend: new SpendCap(1, prices),
    });
    scorer.prepare(context);
    await scorer.scoreRelations(candidates);
    expect(backend.prompts.map((p) => p.user.split("\n")[0])).toEqual([
      "SOURCE: src/sub.ts",
    ]);
    expect(scorer.report().overLimit).toBe(1);
  });
});

describe("anthropicBackend (the SDK against a fake fetch)", () => {
  const verdict = { probability: 0.7, relation: "same-feature", symbols: [] };
  const message = (stop: string) =>
    new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(verdict) }],
        stop_reason: stop,
        stop_sequence: null,
        usage: {
          input_tokens: 1200,
          output_tokens: 40,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  it("sends the key only to api.anthropic.com, with structured output at low effort", async () => {
    const seen: { url: string; headers: Headers; body: unknown }[] = [];
    const net = createNet({
      offline: false,
      allow: [ANTHROPIC_ORIGIN],
      fetch: (input, init) => {
        seen.push({
          url:
            input instanceof Request
              ? input.url
              : input instanceof URL
                ? input.href
                : input,
          headers: new Headers(init?.headers),
          body: JSON.parse(typeof init?.body === "string" ? init.body : "null"),
        });
        return Promise.resolve(message("end_turn"));
      },
    });
    const backend = anthropicBackend({
      apiKey: "test-key",
      model: "claude-haiku-5-5",
      net,
    });
    const out = await backend.judge({ system: "s", user: "u" });
    expect(out).toEqual({
      verdict,
      usage: { inputTokens: 1200, outputTokens: 40 },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${ANTHROPIC_ORIGIN}/v1/messages`);
    expect(seen[0]?.headers.get("x-api-key")).toBe("test-key");
    expect(seen[0]?.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 2048,
      system: "s",
      messages: [{ role: "user", content: "u" }],
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
  });

  it("returns no verdict for a refusal, and gives up on a refused key", async () => {
    const refusal = anthropicBackend({
      apiKey: "k",
      model: "claude-haiku-5-5",
      net: createNet({
        offline: false,
        allow: [ANTHROPIC_ORIGIN],
        fetch: () => Promise.resolve(message("refusal")),
      }),
    });
    expect(
      (await refusal.judge({ system: "s", user: "u" })).verdict,
    ).toBeNull();
    const badKey = anthropicBackend({
      apiKey: "k",
      model: "claude-haiku-5-5",
      net: createNet({
        offline: false,
        allow: [ANTHROPIC_ORIGIN],
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                type: "error",
                error: {
                  type: "authentication_error",
                  message: "invalid x-api-key",
                },
              }),
              { status: 401, headers: { "content-type": "application/json" } },
            ),
          ),
      }),
    });
    await expect(badKey.judge({ system: "s", user: "u" })).rejects.toThrow(
      BackendFatal,
    );
  });

  it("sends nothing when offline", async () => {
    let calls = 0;
    const backend = anthropicBackend({
      apiKey: "k",
      model: "claude-haiku-5-5",
      net: createNet({
        offline: true,
        allow: [ANTHROPIC_ORIGIN],
        fetch: () => {
          calls++;
          return Promise.resolve(message("end_turn"));
        },
      }),
    });
    await expect(backend.judge({ system: "s", user: "u" })).rejects.toThrow(
      BackendFatal,
    );
    expect(calls).toBe(0);
  });
});

describe("ollamaBackend (against a fake fetch)", () => {
  it("asks the local server for structured output, without streaming", async () => {
    const bodies: unknown[] = [];
    const backend = ollamaBackend({
      model: "llama3.1",
      net: createNet({
        offline: false,
        allow: [OLLAMA_ORIGIN],
        fetch: (input, init) => {
          expect(input).toBe(`${OLLAMA_ORIGIN}/api/chat`);
          bodies.push(
            JSON.parse(typeof init?.body === "string" ? init.body : "null"),
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
                prompt_eval_count: 900,
                eval_count: 20,
              }),
              { status: 200 },
            ),
          );
        },
      }),
    });
    expect(backend.remote).toBe(false);
    expect(await backend.judge({ system: "s", user: "u" })).toEqual({
      verdict: { probability: 0.3, relation: "unclear", symbols: [] },
      usage: { inputTokens: 900, outputTokens: 20 },
    });
    expect(bodies[0]).toMatchObject({
      model: "llama3.1",
      stream: false,
      format: { type: "object" },
      options: { temperature: 0 },
    });
  });
});
