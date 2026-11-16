import { extract as extractGo } from "@epoch-dev/adapter-go/extract";
import { extract as extractPython } from "@epoch-dev/adapter-python/extract";
import {
  extract as extractTypescript,
  hasSyntaxErrors as hasSyntaxErrorsTypescript,
} from "@epoch-dev/adapter-typescript/extract";
import { anySyntaxError, type Extractor } from "./extract-file.js";

/**
 * Each built-in adapter's extract functions, by adapter id, imported through
 * the adapters' extract-only entry points. Parse workers use these, so a
 * worker never loads what only resolution needs (the TypeScript compiler).
 * A test keeps this table in step with DEFAULT_REGISTRATIONS.
 */
export const EXTRACTORS: Readonly<Record<string, Extractor>> = {
  typescript: {
    extract: extractTypescript,
    hasSyntaxErrors: hasSyntaxErrorsTypescript,
  },
  python: { extract: extractPython, hasSyntaxErrors: anySyntaxError },
  go: { extract: extractGo, hasSyntaxErrors: anySyntaxError },
};
