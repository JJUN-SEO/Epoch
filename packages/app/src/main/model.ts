import fs from "node:fs";
import path from "node:path";

/*
 * Where the analysis host finds the local embedding model (ADR-008). The
 * installer carries it (electron-builder.yml, extraResources "model"); the
 * app never downloads one. An unpackaged build (development, e2e) uses
 * EPOCH_EMBEDDING_MODEL, else the repository's models/<default> that
 * scripts/fetch-model.mjs fetched. A packaged app takes only "off" from the
 * environment (it can only turn the model off), so nothing outside the
 * installer chooses the model it runs.
 */

const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/i;

const described = (dir: string) =>
  fs.existsSync(path.join(dir, "epoch-model.json"));

/** The model folder to hand the host, or undefined when there is none. */
export function embeddingModelDir(opts: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  /** The app's folder (packages/app when unpackaged). */
  readonly appPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): string | undefined {
  const fromEnv = opts.env.EPOCH_EMBEDDING_MODEL;
  if (fromEnv === "off") return undefined;
  if (opts.packaged) {
    const dir = path.join(opts.resourcesPath, "model");
    return described(dir) ? dir : undefined;
  }
  // A wrong folder is reported by the host as an unavailable model.
  if (fromEnv !== undefined && fromEnv !== "") return path.resolve(fromEnv);
  const models = path.resolve(opts.appPath, "../../models");
  let id: unknown;
  try {
    id = (
      JSON.parse(
        fs.readFileSync(path.join(models, "manifest.json"), "utf8"),
      ) as { default?: unknown }
    ).default;
  } catch {
    return undefined;
  }
  if (typeof id !== "string" || !MODEL_ID.test(id)) return undefined;
  const dir = path.join(models, id);
  return described(dir) ? dir : undefined;
}

/** The analysis host's arguments that name the model folder. */
export const hostModelArgs = (dir: string | undefined): string[] =>
  dir === undefined ? [] : ["--embedding-model", dir];
