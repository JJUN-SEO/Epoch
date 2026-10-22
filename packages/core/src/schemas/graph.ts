import { z } from "zod";
import { FlagUsage } from "./facts.js";
import { Finding } from "./finding.js";
import { UnresolvedImport } from "./resolution.js";

/** Current `Graph.schemaVersion`. Bump on any breaking change to the Graph shape. */
export const GRAPH_SCHEMA_VERSION = 2;

export const EntryPoint = z.strictObject({
  file: z.string().min(1),
  reason: z.enum(["manifest", "script", "config", "convention", "test"]),
  source: z.string(),
});
export type EntryPoint = z.infer<typeof EntryPoint>;

const Count = z.number().int().nonnegative();

/**
 * Node id: repo-relative path with forward slashes (files) or "pkg:<import path>" (Go packages).
 * Optional metrics are absent until computed (ADR-011).
 */

/** Risk tiers, most to least risky (CLAUDE.md "Risk tiers", ADR-015). */
export const RiskTier = z.enum([
  "critical",
  "high",
  "moderate",
  "low-moderate",
  "low",
]);
export type RiskTier = z.infer<typeof RiskTier>;

export const RiskArchetype = z.enum([
  "volatile-core",
  "active-hotspot",
  "warm-core",
  "fragile-leaf",
  "frozen-core",
  "stable-leaf",
]);
export type RiskArchetype = z.infer<typeof RiskArchetype>;

export const GraphNode = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["file", "package"]),
  language: z.string().min(1),
  loc: Count,
  /** For package nodes: hash of the sorted member file hashes. */
  contentHash: z.string().min(1),
  exports: z.array(z.string()),
  /** Third-party packages this node imports. */
  externals: z.array(z.string()),
  flags: z.array(FlagUsage),
  role: z
    .strictObject({ label: z.string(), confidence: z.number().min(0).max(1) })
    .exactOptional(),
  metrics: z.strictObject({
    fanIn: Count,
    fanOut: Count,
    /** Transitive dependents over the certain edge set (blast radius, certain). */
    dependents: Count.exactOptional(),
    churn90d: Count.exactOptional(),
    coverage: z.number().min(0).max(1).exactOptional(),
    /** Absent without git history (ADR-011, ADR-015). */
    risk: z
      .strictObject({ tier: RiskTier, archetype: RiskArchetype })
      .exactOptional(),
  }),
});
export type GraphNode = z.infer<typeof GraphNode>;

export const EdgeKind = z.enum([
  "import",
  "dynamic-import",
  "reexport",
  "type-only",
  "via-barrel",
  "cochange",
  "shared-string",
  "semantic",
]);
export type EdgeKind = z.infer<typeof EdgeKind>;

export const Provenance = z.enum([
  "resolver",
  "syntactic",
  "git-cochange",
  "shared-string",
  "embedding",
  "trace",
  "model",
]);
export type Provenance = z.infer<typeof Provenance>;

/** Edge direction: `source` depends on `target` (source imports target). */
export const GraphEdge = z.strictObject({
  source: z.string().min(1),
  target: z.string().min(1),
  kind: EdgeKind,
  provenance: Provenance,
  /** 1.0 for resolver-proven facts; below 1 for hints. */
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Graph = z.strictObject({
  schemaVersion: z.number().int().positive(),
  /** Sorted by id. */
  nodes: z.array(GraphNode),
  /** Sorted by (source, target, kind). */
  edges: z.array(GraphEdge),
  /** Sorted by file. */
  roots: z.array(EntryPoint),
  /** Sorted by (kind, subject.name, id). */
  findings: z.array(Finding),
  /** Sorted by (from, line). */
  unresolved: z.array(UnresolvedImport),
});
export type Graph = z.infer<typeof Graph>;
