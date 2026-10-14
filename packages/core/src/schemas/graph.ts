import { z } from "zod";
import { FlagUsage } from "./facts.js";
import { Finding } from "./finding.js";
import { UnresolvedImport } from "./resolution.js";

/** Current `Graph.schemaVersion`. Bump on any breaking change to the Graph shape. */
export const GRAPH_SCHEMA_VERSION = 1;

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
    churn90d: Count.exactOptional(),
    coverage: z.number().min(0).max(1).exactOptional(),
    riskScore: z.number().min(0).max(100).exactOptional(),
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
