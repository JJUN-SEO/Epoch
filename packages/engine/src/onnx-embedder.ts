import fs from "node:fs";
import path from "node:path";
import { Tokenizer } from "./tokenizer.js";
import ort from "onnxruntime-node";
import { z } from "zod";
import type { Embedder } from "@epoch-dev/core";

/*
 * The local embedding model (M6, ADR-008): a sentence-embedding ONNX model
 * run on the CPU by onnxruntime-node, with its own WordPiece tokenizer
 * (@huggingface/tokenizers, pure JavaScript). Everything is read from the
 * model folder that scripts/fetch-model.mjs writes at build time; nothing is
 * downloaded at run time. Texts are cut to the model's token limit, pooled
 * as the model was trained (mean of the token vectors, or the [CLS] vector)
 * and scaled to unit length.
 */

export const ModelSpec = z.object({
  id: z.string().min(1),
  revision: z.string().min(1),
  pooling: z.enum(["mean", "cls"]),
  normalize: z.boolean(),
  maxTokens: z.number().int().min(3),
  dimensions: z.number().int().positive(),
});
export type ModelSpec = z.infer<typeof ModelSpec>;

/*
 * One text per run: the runtime picks different numeric kernels for
 * different tensor shapes, so a text padded into a batch gets a vector that
 * differs in the last bits from the same text alone. Running texts one at a
 * time keeps every vector a function of its text, so a cached vector equals
 * the one a fresh run computes (incremental and full analyses agree).
 */
const BATCH = 1;

export interface OnnxEmbedder extends Embedder {
  readonly spec: ModelSpec;
  /** Frees the native session. */
  close(): Promise<void>;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Loads the model in `dir` (epoch-model.json, model.onnx, tokenizer.json,
 * tokenizer_config.json). Throws if a file is missing or malformed.
 */
export async function loadOnnxEmbedder(dir: string): Promise<OnnxEmbedder> {
  const spec = ModelSpec.parse(readJson(path.join(dir, "epoch-model.json")));
  // The Tokenizer takes the parsed JSON files as plain objects.
  const tokenizer = new Tokenizer(
    readJson(path.join(dir, "tokenizer.json")) as object,
    readJson(path.join(dir, "tokenizer_config.json")) as object,
  );
  const cls = tokenizer.token_to_id("[CLS]");
  const sep = tokenizer.token_to_id("[SEP]");
  const pad = tokenizer.token_to_id("[PAD]") ?? 0;
  if (cls === undefined || sep === undefined) {
    throw new Error(`${spec.id}: the tokenizer has no [CLS] or [SEP] token`);
  }
  const session = await ort.InferenceSession.create(
    path.join(dir, "model.onnx"),
    { executionProviders: ["cpu"], graphOptimizationLevel: "all" },
  );
  const inputs = new Set(session.inputNames);
  const output = session.outputNames.includes("last_hidden_state")
    ? "last_hidden_state"
    : session.outputNames[0];
  if (output === undefined)
    throw new Error(`${spec.id}: the model has no output`);
  const outputName: string = output;

  /** [CLS] + the text's first tokens + [SEP], within the model's limit. */
  const encode = (text: string): number[] => [
    cls,
    ...tokenizer
      .encode(text, { add_special_tokens: false })
      .ids.slice(0, spec.maxTokens - 2),
    sep,
  ];

  async function embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    const encoded = texts.map(encode);
    const seq = Math.max(...encoded.map((e) => e.length));
    const n = encoded.length;
    const ids = new BigInt64Array(n * seq);
    const mask = new BigInt64Array(n * seq);
    for (const [b, e] of encoded.entries()) {
      for (let t = 0; t < seq; t++) {
        ids[b * seq + t] = BigInt(t < e.length ? (e[t] ?? pad) : pad);
        mask[b * seq + t] = t < e.length ? 1n : 0n;
      }
    }
    const feeds: Record<string, ort.Tensor> = {};
    if (inputs.has("input_ids"))
      feeds.input_ids = new ort.Tensor("int64", ids, [n, seq]);
    if (inputs.has("attention_mask"))
      feeds.attention_mask = new ort.Tensor("int64", mask, [n, seq]);
    if (inputs.has("token_type_ids"))
      feeds.token_type_ids = new ort.Tensor(
        "int64",
        new BigInt64Array(n * seq),
        [n, seq],
      );
    const result = await session.run(feeds, [outputName]);
    const hidden = result[outputName];
    if (!hidden || !(hidden.data instanceof Float32Array)) {
      throw new Error(`${spec.id}: unexpected model output`);
    }
    const dims = hidden.dims[2] ?? 0;
    const data = hidden.data;
    const out: Float32Array[] = [];
    for (const [b, e] of encoded.entries()) {
      const v = new Float32Array(dims);
      if (spec.pooling === "cls") {
        for (let d = 0; d < dims; d++) v[d] = data[b * seq * dims + d] ?? 0;
      } else {
        for (let t = 0; t < e.length; t++) {
          for (let d = 0; d < dims; d++)
            v[d] = (v[d] ?? 0) + (data[(b * seq + t) * dims + d] ?? 0);
        }
        for (let d = 0; d < dims; d++) v[d] = (v[d] ?? 0) / e.length;
      }
      if (spec.normalize) {
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm);
        if (norm > 0) for (let d = 0; d < dims; d++) v[d] = (v[d] ?? 0) / norm;
      }
      out.push(v);
    }
    return out;
  }

  return {
    spec,
    modelId: `${spec.id}@${spec.revision.slice(0, 12)}`,
    async embed(texts) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        out.push(...(await embedBatch(texts.slice(i, i + BATCH))));
      }
      return out;
    },
    close: () => session.release(),
  };
}
