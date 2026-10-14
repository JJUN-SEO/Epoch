/**
 * @epoch-dev/engine
 *
 * Runs the analysis pipeline: Discover, Parse, Extract, Resolve and Graph
 * today; the SQLite CacheStore, file watcher, git (churn and history
 * provider), worker pool, config loader and dismissals store arrive in later
 * milestones. Side effects live here (CLAUDE.md, "Repo layout").
 */
export * from "./analyze.js";
export * from "./discover.js";
export * from "./parse.js";
export * from "./reader.js";
