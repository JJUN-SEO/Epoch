/**
 * @epoch-dev/adapter-typescript
 *
 * The TypeScript/JavaScript language adapter (tier A): extracts FileFacts
 * from tree-sitter syntax trees and resolves imports with TypeScript's module
 * resolution API. Pure (CLAUDE.md, "Language adapter interface"): it reads
 * project files only through the supplied FileReader and never writes or
 * executes anything.
 */
import type { Tree } from "web-tree-sitter";
import type { AdapterRegistration, LanguageAdapter } from "@epoch-dev/core";
import { detectEntryPoints } from "./entry-points.js";
import { extract } from "./extract.js";
import { EXTENSIONS, grammarFor, isTestFile, languageFor } from "./files.js";
import { resolveImport } from "./resolve.js";
import { detectProjectRoots } from "./roots.js";

export const typescriptAdapter: LanguageAdapter<Tree> = {
  id: "typescript",
  tier: "A",
  extensions: EXTENSIONS,
  version: "7", // bump whenever extract output can change (cache keys include it)
  detectProjectRoots,
  extract,
  resolveImport,
  detectEntryPoints,
  isTestFile,
};

export const typescriptRegistration: AdapterRegistration<Tree> = {
  adapter: typescriptAdapter,
  grammarFor,
  languageFor,
};

export { countLoc } from "./extract.js";
export { packageName } from "./resolve.js";
export { ROOT_KINDS } from "./roots.js";
