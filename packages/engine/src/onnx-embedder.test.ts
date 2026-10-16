import fs from "node:fs";
/* eslint-disable no-restricted-imports -- imported only to spy on: the test fails if inference opens a connection */
import http from "node:http";
import https from "node:https";
import net from "node:net";
/* eslint-enable no-restricted-imports -- only these three */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tokenizer } from "./tokenizer.js";
import { loadOnnxEmbedder } from "./onnx-embedder.js";

/*
 * The embedding runtime on a tiny BERT-shaped model built for tests
 * (fixtures/tiny-embedder/build.py): the same session, tokenizer, padding,
 * pooling and normalization the real models go through, on every OS. When a
 * real model has been fetched (scripts/fetch-model.mjs; CI fetches the
 * default), its tokenizer is also checked against token ids from Hugging
 * Face's Rust tokenizer, and its vectors for being stable.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TINY = path.join(HERE, "fixtures/tiny-embedder");
const MODELS = path.join(HERE, "../../../models");

afterEach(() => {
  vi.restoreAllMocks();
});

const cosine = (a: Float32Array, b: Float32Array) =>
  a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

describe("the ONNX embedder (tiny test model)", () => {
  it("gives the same unit vector for the same text, wherever it is in a call", async () => {
    const e = await loadOnnxEmbedder(TINY);
    try {
      expect(e.modelId).toBe("tiny-embedder@000000000000");
      const [alone] = await e.embed(["export const login = token"]);
      const batch = await e.embed([
        "src / ui / button",
        "export const login = token",
        "the",
      ]);
      expect(alone).toBeDefined();
      expect(Array.from(batch[1] ?? [])).toEqual(Array.from(alone ?? []));
      expect(Math.hypot(...(alone ?? []))).toBeCloseTo(1, 6);
      // A different text points elsewhere.
      expect(
        cosine(alone ?? new Float32Array(), batch[0] ?? new Float32Array()),
      ).toBeLessThan(0.999);
    } finally {
      await e.close();
    }
  });

  it("cuts a text at the model's token limit", async () => {
    const e = await loadOnnxEmbedder(TINY);
    try {
      // maxTokens 16: everything past the first 14 tokens is ignored.
      const head = Array.from({ length: 14 }, () => "token").join(" ");
      const [a, b] = await e.embed([head, `${head} render render render`]);
      expect(Array.from(b ?? [])).toEqual(Array.from(a ?? []));
    } finally {
      await e.close();
    }
  });

  it("runs without any network access", async () => {
    const refuse = () => {
      throw new Error("network access during inference");
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(refuse);
    vi.spyOn(net, "connect").mockImplementation(refuse);
    vi.spyOn(net, "createConnection").mockImplementation(refuse);
    vi.spyOn(http, "request").mockImplementation(refuse);
    vi.spyOn(https, "request").mockImplementation(refuse);
    const e = await loadOnnxEmbedder(TINY);
    try {
      expect(await e.embed(["src / auth / login"])).toHaveLength(1);
    } finally {
      await e.close();
    }
  });

  it("refuses a model folder without its description", async () => {
    await expect(
      loadOnnxEmbedder(path.join(HERE, "fixtures")),
    ).rejects.toThrow();
  });
});

interface Golden {
  readonly strings: readonly string[];
  readonly ids: Readonly<Record<string, readonly (readonly number[])[]>>;
}
const golden = JSON.parse(
  fs.readFileSync(path.join(HERE, "fixtures/tokenizer-golden.json"), "utf8"),
) as Golden;

describe.each(Object.keys(golden.ids))("the %s model, when fetched", (id) => {
  const dir = path.join(MODELS, id);
  const fetched = fs.existsSync(path.join(dir, "model.onnx"));

  it.skipIf(!fs.existsSync(path.join(dir, "tokenizer.json")))(
    "tokenizes exactly as Hugging Face's Rust tokenizer does",
    () => {
      const t = new Tokenizer(
        JSON.parse(
          fs.readFileSync(path.join(dir, "tokenizer.json"), "utf8"),
        ) as object,
        JSON.parse(
          fs.readFileSync(path.join(dir, "tokenizer_config.json"), "utf8"),
        ) as object,
      );
      expect(
        golden.strings.map(
          (s) => t.encode(s, { add_special_tokens: false }).ids,
        ),
      ).toEqual(golden.ids[id]);
    },
  );

  it.skipIf(!fetched)(
    "gives stable unit vectors, closer for related code",
    { timeout: 120_000 },
    async () => {
      const e = await loadOnnxEmbedder(dir);
      try {
        const texts = [
          "src/auth/login.ts\nexport async function login(user, password) { return session.create(user); }",
          "src/auth/session.ts\nexport const session = { create(user) { return signToken(user); } };",
          "src/ui/button.tsx\nexport function Button({ label }) { return <button>{label}</button>; }",
        ];
        const [a, b, c] = await e.embed(texts);
        const again = await e.embed([texts[0] ?? ""]);
        expect(Array.from(again[0] ?? [])).toEqual(Array.from(a ?? []));
        expect(a?.length).toBe(e.spec.dimensions);
        const ab = cosine(a ?? new Float32Array(), b ?? new Float32Array());
        const ac = cosine(a ?? new Float32Array(), c ?? new Float32Array());
        expect(ab).toBeGreaterThan(ac);
      } finally {
        await e.close();
      }
    },
  );
});
