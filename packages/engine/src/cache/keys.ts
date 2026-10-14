import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ExtractorConfig, canonicalJson } from "@epoch-dev/core";

export const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** A dependency's version, read from the package.json above its resolved entry point. */
function packageVersion(name: string): string {
  const require = createRequire(import.meta.url);
  let dir = path.dirname(require.resolve(name));
  for (;;) {
    const file = path.join(dir, "package.json");
    if (fs.existsSync(file)) {
      const manifest: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        manifest.name === name &&
        "version" in manifest &&
        typeof manifest.version === "string"
      ) {
        return manifest.version;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no package.json found for ${name}`);
    dir = parent;
  }
}

/**
 * The parser runtime and grammar package versions (ADR-002). Part of every
 * facts key (ADR-004), so a grammar upgrade can never serve facts extracted
 * by the previous grammar, even if an adapter version bump is forgotten.
 */
export const PARSER_FINGERPRINT = `web-tree-sitter@${packageVersion("web-tree-sitter")}+@vscode/tree-sitter-wasm@${packageVersion("@vscode/tree-sitter-wasm")}`;

/** sha256 of the canonical extractor config (flag patterns, wrappers, env prefixes). */
export function extractorConfigHash(cfg: ExtractorConfig): string {
  return sha256(canonicalJson(ExtractorConfig.parse(cfg)));
}

/**
 * The FileFacts cache key (CLAUDE.md "Local cache", ADR-004): file contents,
 * adapter id and version, parser fingerprint and extractor config.
 */
export function factsKey(p: {
  contentHash: string;
  adapterId: string;
  adapterVersion: string;
  parserFingerprint: string;
  extractorConfigHash: string;
}): string {
  return sha256(
    JSON.stringify([
      p.contentHash,
      p.adapterId,
      p.adapterVersion,
      p.parserFingerprint,
      p.extractorConfigHash,
    ]),
  );
}
