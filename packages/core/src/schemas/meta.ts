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
    parse: Ms,
    resolve: Ms,
    graph: Ms,
    total: Ms,
  }),
  counts: z.strictObject({
    filesAnalyzed: Count,
    nodes: Count,
    edges: Count,
    externals: Count,
    unresolved: Count,
    skipped: Count,
  }),
  /** Files the walk saw but did not analyze (ignored directories are not listed). */
  skipped: z.array(z.strictObject({ path: z.string(), reason: SkipReason })),
  /** Strongly connected components over certain-mode edges (size > 1 or self-loop). */
  cycles: z.array(z.array(z.string())),
  host: z.strictObject({
    platform: z.string(),
    arch: z.string(),
    node: z.string(),
  }),
});
export type AnalysisMeta = z.infer<typeof AnalysisMeta>;
