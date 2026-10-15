import { z } from "zod";

const Ms = z.number().nonnegative();
const Count = z.number().int().nonnegative();

export const SkipReason = z.enum([
  "ignored",
  "symlink",
  "too-large",
  "unreadable",
]);
export type SkipReason = z.infer<typeof SkipReason>;

/**
 * Run metadata, kept outside the canonical Graph (CLAUDE.md "Canonical form"):
 * timings, versions and host details vary between runs; the Graph must not.
 */
export const AnalysisMeta = z.strictObject({
  epochVersion: z.string(),
  schemaVersion: z.number().int().positive(),
  adapters: z.array(
    z.strictObject({
      id: z.string(),
      version: z.string(),
      tier: z.enum(["A", "B"]),
    }),
  ),
  timingsMs: z.strictObject({
    discover: Ms,
    /** Change detection: stat, hashing and cache lookups. */
    changes: Ms,
    parse: Ms,
    resolve: Ms,
    graph: Ms,
    /** Git churn, coverage and risk. */
    score: Ms,
    /** Dead-feature detectors, git history lookups included. */
    findings: Ms,
    total: Ms,
  }),
  counts: z.strictObject({
    filesAnalyzed: Count,
    nodes: Count,
    edges: Count,
    externals: Count,
    unresolved: Count,
    skipped: Count,
    parseErrors: Count,
    /** Source files whose FileFacts came from the cache. */
    cacheHits: Count,
    /** Source files that were parsed and extracted this run. */
    cacheMisses: Count,
    /** Source files read and hashed because the manifest could not vouch for them. */
    rehashed: Count,
  }),
  /** Files the walk saw but did not analyze (ignored directories are not listed). */
  skipped: z.array(z.strictObject({ path: z.string(), reason: SkipReason })),
  /** Analyzed files whose syntax trees had errors; their facts are best-effort. */
  parseErrors: z.array(z.string()),
  /** Strongly connected components over certain-mode edges (size > 1 or self-loop). */
  cycles: z.array(z.array(z.string())),
  /** Git history behind churn90d and riskScore (M4). */
  git: z.strictObject({
    status: z.enum([
      "usable",
      "not-a-repo",
      "no-commits",
      "git-unavailable",
      "off",
    ]),
    /** Only part of the history was fetched; churn counts what is there. */
    shallow: z.boolean().optional(),
    head: z.string().optional(),
    /** The churn window, Unix seconds: 90 days before HEAD's commit date. */
    churnSince: z.number().int().optional(),
    churnUntil: z.number().int().optional(),
  }),
  /** The coverage report behind metrics.coverage, if one was found. */
  coverage: z
    .strictObject({
      /** Repo-relative when found in the project; as given otherwise. */
      source: z.string(),
      format: z.enum(["lcov", "cobertura"]),
      /** Analyzed files the report covers. */
      files: Count,
      /** Report entries matching no analyzed file. */
      unmatched: Count,
      /** Report entries matching several analyzed files equally. */
      ambiguous: Count,
    })
    .nullable(),
  /** epoch.config.json: whether one was found, and its problems (defaults apply). */
  config: z.strictObject({
    present: z.boolean(),
    warnings: z.array(z.string()),
  }),
  /** The Findings stage (M5): what it could check, and what it found. */
  findings: z.strictObject({
    /** Git history for stale-flag and recency: usable, why not, or off. */
    history: z.enum(["usable", "not-a-repo", "shallow", "too-short", "off"]),
    /** Flag usages whose key is not a string literal (cannot be assessed). */
    unassessableFlags: Count,
    counts: z.strictObject({ high: Count, medium: Count, low: Count }),
    /** Frameworks that load files by convention, for the entryPoints notice. */
    frameworks: z.array(
      z.strictObject({
        id: z.string(),
        name: z.string(),
        dir: z.string(),
        evidence: z.string(),
      }),
    ),
  }),
  host: z.strictObject({
    platform: z.string(),
    arch: z.string(),
    node: z.string(),
  }),
});
export type AnalysisMeta = z.infer<typeof AnalysisMeta>;
