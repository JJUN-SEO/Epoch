import { z } from "zod";

export const FlagPattern = z.strictObject({
  /** e.g. "openfeature.get-boolean-value". */
  id: z.string().min(1),
  provider: z.string().min(1),
  language: z.string().min(1),
  /** Function or method name. */
  callee: z.string().min(1),
  /** Which argument holds the flag key. */
  keyArgIndex: z.number().int().nonnegative(),
  /** Package/module names; if the file imports one, a match is "strong". */
  importHints: z.array(z.string()),
  /** Required: URL of the official docs the entry was authored from. */
  source: z.url(),
});
export type FlagPattern = z.infer<typeof FlagPattern>;

export const ExtractorConfig = z.strictObject({
  flagPatterns: z.array(FlagPattern),
  /** From epoch.config.json. */
  wrapperFunctions: z.array(z.string()),
  /** From epoch.config.json; plain prefix match, never regex. */
  envPrefixes: z.array(z.string()),
});
export type ExtractorConfig = z.infer<typeof ExtractorConfig>;

/** The extractor config used until M5 gives it content. */
export const EMPTY_EXTRACTOR_CONFIG: ExtractorConfig = Object.freeze({
  flagPatterns: [],
  wrapperFunctions: [],
  envPrefixes: [],
});
