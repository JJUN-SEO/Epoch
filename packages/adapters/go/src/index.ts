/**
 * @epoch-dev/adapter-go
 *
 * The Go language adapter. It extracts FileFacts from tree-sitter syntax
 * trees and resolves imports to packages from go.mod and go.work, read as
 * data (ADR-013). Production files fold into one `pkg:<import path>` node per
 * package; test files stay file nodes. Pure (CLAUDE.md "Language adapter
 * interface"): it reads project files only through the supplied FileReader,
 * never writes, and never runs the go command (ADR-006).
 *
 * Tier "A": it passes the conformance suite, and on cli/cli its package
 * edges match `go list` at 100% precision and recall, every test-file
 * difference explained (docs/benchmarks/go.md).
 */
import type { Tree } from "web-tree-sitter";
import type { AdapterRegistration, LanguageAdapter } from "@epoch-dev/core";
import { extract } from "./extract.js";
import { EXTENSIONS, grammarFor, isTestFile, languageFor } from "./files.js";
import { detectEntryPoints } from "./entry-points.js";
import { detectProjectRoots, packageFor } from "./modules.js";
import { resolveImport } from "./resolve.js";

export const goAdapter: LanguageAdapter<Tree> = {
  id: "go",
  tier: "A",
  extensions: EXTENSIONS,
  version: "2", // bump whenever extract output can change (cache keys include it)
  detectProjectRoots,
  extract,
  resolveImport,
  detectEntryPoints,
  isTestFile,
};

export const goRegistration: AdapterRegistration<Tree> = {
  adapter: goAdapter,
  grammarFor,
  languageFor,
  packageFor,
};

export { countLoc } from "./extract.js";
export { parseModFile } from "./modfile.js";
