/**
 * @epoch-dev/adapter-python
 *
 * The Python language adapter. It extracts FileFacts from tree-sitter syntax
 * trees and resolves imports from Python's import system rules over the
 * discovered files, with source roots read from pyproject.toml and setup.cfg
 * as data. Pure (CLAUDE.md "Language adapter interface"): it reads project
 * files only through the supplied FileReader, never writes, and never runs
 * Python (ADR-006).
 *
 * Tier "A": it passes the conformance suite, and on Flask its module edges
 * match grimp at 100% recall and, counting the imports grimp cannot see
 * (namespace subpackages), 100% precision (docs/benchmarks/python-accuracy.md).
 * CLAUDE.md allows a Tier A claim only with a measured number.
 */
import type { Tree } from "web-tree-sitter";
import type { AdapterRegistration, LanguageAdapter } from "@epoch-dev/core";
import { extract } from "./extract.js";
import { EXTENSIONS, grammarFor, isTestFile, languageFor } from "./files.js";
import { resolveImport } from "./resolve.js";
import { detectProjectRoots } from "./roots.js";

export const pythonAdapter: LanguageAdapter<Tree> = {
  id: "python",
  tier: "A",
  extensions: EXTENSIONS,
  version: "1", // bump whenever extract output can change (cache keys include it)
  detectProjectRoots,
  extract,
  resolveImport,
  detectEntryPoints: () => [], // M5
  isTestFile,
};

export const pythonRegistration: AdapterRegistration<Tree> = {
  adapter: pythonAdapter,
  grammarFor,
  languageFor,
};

export { countLoc } from "./extract.js";
export { ROOT_KINDS } from "./roots.js";
