import type { Tree } from "web-tree-sitter";
import type { LanguageAdapter } from "@epoch-dev/core";
import { extract as extractGo } from "@epoch-dev/adapter-go/extract";
import { extract as extractPython } from "@epoch-dev/adapter-python/extract";
import { extract as extractTypescript } from "@epoch-dev/adapter-typescript/extract";

/**
 * Each built-in adapter's extract function, by adapter id, imported through
 * the adapters' extract-only entry points. Parse workers use these, so a
 * worker never loads what only resolution needs (the TypeScript compiler).
 * A test keeps this table in step with DEFAULT_REGISTRATIONS.
 */
export const EXTRACTORS: Readonly<
  Record<string, LanguageAdapter<Tree>["extract"]>
> = {
  typescript: extractTypescript,
  python: extractPython,
  go: extractGo,
};
