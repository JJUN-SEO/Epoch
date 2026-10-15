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
 * Tier "B" until its accuracy is measured against `go list` (M4): CLAUDE.md
 * allows a Tier A claim only with a measured number.
 */
import type { Tree } from "web-tree-sitter";
import type { AdapterRegistration, LanguageAdapter } from "@epoch-dev/core";
import { extract } from "./extract.js";
import { EXTENSIONS, grammarFor, isTestFile, languageFor } from "./files.js";
import { detectProjectRoots, packageFor } from "./modules.js";
import { resolveImport } from "./resolve.js";

export const goAdapter: LanguageAdapter<Tree> = {
  id: "go",
  tier: "B",
  extensions: EXTENSIONS,
  version: "1", // bump whenever extract output can change (cache keys include it)
  detectProjectRoots,
  extract,
  resolveImport,
  detectEntryPoints: () => [], // M5
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
