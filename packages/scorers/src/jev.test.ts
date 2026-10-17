import { describe, expect, it } from "vitest";
import { BackendFatal } from "./model.js";
import { createNet } from "./net.js";
import { DEFAULT_JEV_MODEL, JEV_ORIGIN, jevBackend } from "./jev.js";

const KEY = "jev-test-key-never-sent";

interface Seen {
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
}

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  input instanceof Request
    ? input.url
    : input instanceof URL
      ? input.href
      : input;

/** The documented response (docs.typesafe.ai/api): one answer per question id, and usage. */
const answer = (noul: number, choice = "same-feature", status = 200) =>
  new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: {
        cochange: { type: "noul", noul },
        relation: {
          type: "choice",
          choice,
          probabilities: { [choice]: 0.9 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 1234, output_tokens: 40 },
    }),
    { status, headers: { "content-type": "application/json" } },
  );

function fake(responses: (() => Response)[]) {
  const seen: Seen[] = [];
  const slept: number[] = [];
  let i = 0;
  const backend = jevBackend({
    apiKey: KEY,
    net: createNet({
      offline: false,
      allow: [JEV_ORIGIN],
      fetch: (input, init) => {
        seen.push({
          url: urlOf(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(typeof init?.body === "string" ? init.body : "null"),
        });
        const next = responses[Math.min(i++, responses.length - 1)];
        return Promise.resolve(next ? next() : answer(0.5));
      },
    }),
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  });
  return { backend, seen, slept };
}

const prompt = {
  system: "ignored by Jev",
  user: "SOURCE: a.ts\n...\nTARGET: b.ts",
};

describe("jevBackend (against a fake fetch)", () => {
  it("poses the pair as a noul and a choice over the same evidence, with the key only in the bearer header", async () => {
    const { backend, seen } = fake([() => answer(0.42, "shared-contract")]);
    expect(backend.remote).toBe(true);
    expect(backend.destination).toBe(JEV_ORIGIN);
    expect(backend.id).toBe(`jev:${DEFAULT_JEV_MODEL}`);
    expect(await backend.judge(prompt)).toEqual({
      verdict: {
        probability: 0.42,
        relation: "shared-contract",
        symbols: [],
      },
      usage: { inputTokens: 1234, outputTokens: 40 },
    });
    expect(seen).toHaveLength(1);
    const req = seen[0];
    expect(req?.url).toBe(`${JEV_ORIGIN}/v1/systemone`);
    expect(req?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req?.headers.get("content-type")).toBe("application/json");
    expect(JSON.stringify(req?.body)).not.toContain(KEY);
    expect(req?.body).toMatchObject({
      model: DEFAULT_JEV_MODEL,
      state: { pair: prompt.user },
      questions: {
        cochange: { type: "noul" },
        relation: { type: "choice" },
      },
    });
    // The system prompt is the LLM's; Jev gets its own typed questions.
    expect(JSON.stringify(req?.body)).not.toContain("ignored by Jev");
  });

  it("retries 429 and 529 with backoff, then gives up for the run", async () => {
    const limited = () => new Response("{}", { status: 429 });
    const overloaded = () =>
      new Response("{}", { status: 529, headers: { "retry-after": "2" } });
    const ok = fake([limited, overloaded, () => answer(0.7)]);
    expect((await ok.backend.judge(prompt)).verdict?.probability).toBe(0.7);
    expect(ok.seen).toHaveLength(3);
    expect(ok.slept).toEqual([1000, 2000]);

    const never = fake([limited]);
    await expect(never.backend.judge(prompt)).rejects.toThrow(
      "Jev: rate limited (HTTP 429) after 4 attempts",
    );
  });

  it("stops the run on a refused key, with a fixed message that never holds provider text or the key", async () => {
    for (const status of [401, 403]) {
      const { backend } = fake([
        () =>
          new Response(
            JSON.stringify({ error: `bad key ${KEY} PROVIDER-TEXT` }),
            {
              status,
            },
          ),
      ]);
      const err = await backend.judge(prompt).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BackendFatal);
      const message = (err as Error).message;
      expect(message).toBe(
        `Jev: TypeSafe refused the key (HTTP ${String(status)})`,
      );
      expect(message).not.toContain(KEY);
      expect(message).not.toContain("PROVIDER-TEXT");
    }
  });

  it("leaves one pair unscored on a bad request or an answer outside the schema", async () => {
    const none = { inputTokens: 0, outputTokens: 0 };
    for (const res of [
      () => new Response('{"detail":"max_tokens_exceeded"}', { status: 400 }),
      () => new Response("{}", { status: 422 }),
      () => new Response("{}", { status: 500 }),
      () => new Response("not json", { status: 200 }),
      () => answer(Number.NaN),
      () => answer(0.5, "made-up-relation"),
    ]) {
      const { backend } = fake([res]);
      const r = await backend.judge(prompt);
      expect(r.verdict).toBeNull();
      if (r.usage.inputTokens !== 1234) expect(r.usage).toEqual(none);
    }
  });

  it("clamps nothing itself and keeps the documented 0..1 noul", async () => {
    const { backend } = fake([() => answer(1)]);
    expect((await backend.judge(prompt)).verdict?.probability).toBe(1);
  });

  it("sends nothing when offline, or to any origin but TypeSafe's API", async () => {
    let calls = 0;
    const count = () => {
      calls++;
      return Promise.resolve(answer(0.5));
    };
    const offline = jevBackend({
      apiKey: KEY,
      net: createNet({ offline: true, allow: [JEV_ORIGIN], fetch: count }),
    });
    await expect(offline.judge(prompt)).rejects.toThrow(BackendFatal);
    const elsewhere = jevBackend({
      apiKey: KEY,
      net: createNet({
        offline: false,
        allow: ["https://api.anthropic.com"],
        fetch: count,
      }),
    });
    await expect(elsewhere.judge(prompt)).rejects.toThrow(BackendFatal);
    expect(calls).toBe(0);
  });

  it("says it cannot reach TypeSafe without repeating the underlying error", async () => {
    const backend = jevBackend({
      apiKey: KEY,
      net: createNet({
        offline: false,
        allow: [JEV_ORIGIN],
        fetch: () => Promise.reject(new Error(`socket said ${KEY}`)),
      }),
    });
    const err = await backend.judge(prompt).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackendFatal);
    expect((err as Error).message).toBe("Jev: could not reach api.typesafe.ai");
  });
});
