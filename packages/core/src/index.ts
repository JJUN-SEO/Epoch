/**
 * @epoch-dev/core
 *
 * Schemas, interfaces, canonicalization, the pure graph algorithms (blast
 * radius, reachability, strongly connected components) and risk scoring.
 * Pure: no I/O (CLAUDE.md, "Repo layout").
 */
export * from "./schemas/index.js";
export * from "./canonical.js";
export * from "./policy.js";
export * from "./graph/reachability.js";
export * from "./graph/scc.js";
export type * from "./interfaces/adapter.js";
export type * from "./interfaces/services.js";
export type * from "./interfaces/api.js";
export * from "./graph/build.js";
