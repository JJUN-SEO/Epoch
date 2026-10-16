import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Embedder } from "@epoch-dev/core";

/*
 * A local embedding model folder (ADR-008), as scripts/fetch-model.mjs
 * writes it at build time: epoch-model.json (this description),
 * model.onnx, tokenizer.json and tokenizer_config.json. Nothing here loads
 * the native runtime; localEmbedder starts it on first use.
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

/** A model folder's description. Throws if it is missing or malformed. */
export function readModelSpec(dir: string): ModelSpec {
  return ModelSpec.parse(
    JSON.parse(fs.readFileSync(path.join(dir, "epoch-model.json"), "utf8")),
  );
}

/** The id vectors are cached under: the model and its pinned revision. */
export const modelIdOf = (spec: ModelSpec): string =>
  `${spec.id}@${spec.revision.slice(0, 12)}`;

export interface LocalEmbedder extends Embedder {
  readonly spec: ModelSpec;
  /** Frees the native session, if one was started. */
  close(): Promise<void>;
}

/**
 * The model in `dir`, started on its first embed call: a run whose vectors
 * are all cached never loads the runtime. Throws now if the description is
 * missing or malformed; a model that fails to load fails that first call
 * (the Enrich stage then reports the model unavailable and goes on).
 */
export function localEmbedder(dir: string): LocalEmbedder {
  const spec = readModelSpec(dir);
  let loading: Promise<LocalEmbedder> | undefined;
  const load = () =>
    (loading ??= import("./onnx-embedder.js").then((m) =>
      m.loadOnnxEmbedder(dir),
    ));
  return {
    spec,
    modelId: modelIdOf(spec),
    embed: async (texts) => (await load()).embed(texts),
    close: async () => {
      if (!loading) return;
      const started = await loading.catch(() => undefined);
      await started?.close();
    },
  };
}
