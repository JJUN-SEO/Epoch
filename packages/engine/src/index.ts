/**
 * @epoch-dev/engine
 *
 * Runs the analysis pipeline: Discover, Parse, Extract (in-process or in a
 * worker pool), Resolve, Graph, Enrich, Score and Findings, with the SQLite
 * CacheStore, git churn and co-change, coverage reports, the history
 * provider, the config loader, the dismissals store and the file watcher.
 * Side effects live here (CLAUDE.md, "Repo layout").
 */
export * from "./analyze.js";
export * from "./config.js";
export * from "./extract-file.js";
export * from "./pool.js";
export type { ParseTask } from "./parse-worker.js";
export * from "./discover.js";
export * from "./parse.js";
export * from "./reader.js";
export * from "./cache/index.js";
export * from "./git.js";
export * from "./changes.js";
export * from "./churn.js";
export * from "./cochange.js";
export * from "./hints.js";
export * from "./embeddings.js";
export * from "./coverage.js";
export * from "./score.js";
export * from "./watch.js";
export * from "./history.js";
export * from "./frameworks.js";
export * from "./dismissals.js";
