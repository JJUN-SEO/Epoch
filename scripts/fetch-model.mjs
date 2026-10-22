// Downloads a pinned embedding model into models/<id>/ at build time (ADR-008).
//
// Usage: node scripts/fetch-model.mjs [<id>... | --all]   (default: the
// manifest's default model). Each file comes from its pinned Hugging Face
// revision and must match the size and sha256 in models/manifest.json, or the
// script fails and leaves nothing behind. A file already present with the
// right hash is kept. models/<id>/epoch-model.json describes the model for the
// engine (pooling, token limit, revision).
//
// This runs on the build machine (and in CI) only: the installer carries the
// model and the installed app never downloads one (docs/privacy.md). Behind a
// proxy, run it with NODE_USE_ENV_PROXY=1.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  readFileSync(path.join(root, "models/manifest.json"), "utf8"),
);
const args = process.argv.slice(2);
const ids = args.includes("--all")
  ? Object.keys(manifest.models)
  : args.length > 0
    ? args
    : [manifest.default];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fetchFile(model, name, file, dir) {
  const target = path.join(dir, name);
  if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) {
    return "kept";
  }
  const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;
  const res = await globalThis.fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${String(res.status)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
    throw new Error(
      `${url}: got ${String(bytes.length)} bytes with sha256 ${sha256(bytes)}, expected ${String(file.size)} bytes with ${file.sha256}`,
    );
  }
  const partial = `${target}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, target);
  return "downloaded";
}

for (const id of ids) {
  const model = manifest.models[id];
  if (!model) throw new Error(`no model "${id}" in models/manifest.json`);
  const dir = path.join(root, "models", id);
  mkdirSync(dir, { recursive: true });
  try {
    for (const [name, file] of Object.entries(model.files)) {
      const how = await fetchFile(model, name, file, dir);
      process.stdout.write(`${id}/${name}: ${how}\n`);
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const { files: _files, ...spec } = model;
  writeFileSync(
    path.join(dir, "epoch-model.json"),
    `${JSON.stringify({ id, ...spec }, null, 2)}\n`,
  );
}
