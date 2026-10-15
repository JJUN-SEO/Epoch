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

const GlobPattern = z.string().min(1).max(1024);
const Glob = z.array(GlobPattern).max(1000);

/** A function or method name a call is matched by (`featureEnabled`). */
const CalleeName = z
  .string()
  .regex(/^[A-Za-z_$][\w$]*$/, "must be a function or method name");

/** Default for flags.staleAfterDays (CLAUDE.md; ADR-007). */
export const DEFAULT_STALE_AFTER_DAYS = 90;

/**
 * epoch.config.json (CLAUDE.md): optional, user-written, read-only to Epoch.
 * Every field has a default, so `{}` is a valid config. Unknown keys are
 * stripped here; the loader reports them as warnings.
 */
export const EpochConfig = z.object({
  /** Extra roots for unreachable-file (globs). */
  entryPoints: Glob.default([]),
  /** Removed from analysis entirely (globs). */
  ignore: Glob.default([]),
  flags: z
    .object({
      wrapperFunctions: z.array(CalleeName).max(200).default([]),
      /** Plain prefix match, never regex. */
      envPrefixes: z.array(z.string().min(1).max(200)).max(200).default([]),
      /** Flags meant to live long (kill switches): never stale. */
      longLived: z.array(z.string().min(1).max(500)).max(1000).default([]),
      staleAfterDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .default(DEFAULT_STALE_AFTER_DAYS),
    })
    .prefault({}),
  findings: z
    .object({
      /** Banner, panel default and CLI default. */
      minConfidence: z.enum(["high", "medium", "low"]).default("medium"),
      /** Findings here are suppressed; the files are still analyzed (globs). */
      ignore: Glob.default([]),
    })
    .prefault({}),
});
export type EpochConfig = z.infer<typeof EpochConfig>;

/** The config when the project has none. */
export const DEFAULT_EPOCH_CONFIG: EpochConfig = EpochConfig.parse({});
