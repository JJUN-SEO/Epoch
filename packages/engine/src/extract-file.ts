import type { Tree } from "web-tree-sitter";
import {
  FileFacts,
  type AdapterRegistration,
  type ExtractorConfig,
  type LanguageAdapter,
} from "@epoch-dev/core";
import type { Parsers } from "./parse.js";

/** What Parse and Extract need from an adapter: the functions behind the cached unit. */
export interface Extractor {
  readonly extract: LanguageAdapter<Tree>["extract"];
  /** Whether the tree has syntax errors that leave the facts best-effort. */
  readonly hasSyntaxErrors: (tree: Tree) => boolean;
}

/** Any error in the tree: what counts unless the adapter decides (AdapterRegistration.hasSyntaxErrors). */
export const anySyntaxError = (tree: Tree): boolean => tree.rootNode.hasError;

/** The Extractor of a registered adapter. */
export function extractorOf(reg: AdapterRegistration<Tree>): Extractor {
  return {
    extract: (file, cfg) => reg.adapter.extract(file, cfg),
    hasSyntaxErrors: (tree) =>
      reg.hasSyntaxErrors?.(tree) ?? anySyntaxError(tree),
  };
}

/**
 * The cached unit for one file (ADR-004): its facts, and whether the parser
 * recovered from a syntax error that leaves them best-effort.
 */
export interface ExtractedFile {
  readonly facts: FileFacts;
  readonly syntaxErrors: boolean;
}

/**
 * Parse and Extract for one file, from bytes already read through the
 * confined FsReader. The same function runs in-process and in parse workers,
 * so both produce identical facts. It reads nothing from disk.
 */
export function extractFile(
  parsers: Parsers,
  extractor: Extractor,
  rel: string,
  grammar: string,
  bytes: Uint8Array,
  config: ExtractorConfig,
): ExtractedFile {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const tree = parsers.parse(grammar, text);
  try {
    const syntaxErrors = extractor.hasSyntaxErrors(tree);
    const facts = FileFacts.parse(
      extractor.extract({ path: rel, text, tree }, config),
    );
    return { facts, syntaxErrors };
  } finally {
    tree.delete();
  }
}
