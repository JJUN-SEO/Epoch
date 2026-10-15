import type { Tree } from "web-tree-sitter";
import {
  EMPTY_EXTRACTOR_CONFIG,
  FileFacts,
  type LanguageAdapter,
} from "@epoch-dev/core";
import type { Parsers } from "./parse.js";

/** The cached unit for one file (ADR-004): its facts and whether the parser had to recover. */
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
  extract: LanguageAdapter<Tree>["extract"],
  rel: string,
  grammar: string,
  bytes: Uint8Array,
): ExtractedFile {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("utf8")
    .replace(/^\uFEFF/, "");
  const tree = parsers.parse(grammar, text);
  try {
    const syntaxErrors = tree.rootNode.hasError;
    const facts = FileFacts.parse(
      extract({ path: rel, text, tree }, EMPTY_EXTRACTOR_CONFIG),
    );
    return { facts, syntaxErrors };
  } finally {
    tree.delete();
  }
}
