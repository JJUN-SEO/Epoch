/**
 * @epoch-dev/engine
 *
 * Runs the analysis pipeline: Discover, Parse, Extract (in-process or in a
 * worker pool), Resolve, Graph and Score, with the SQLite CacheStore, git
 * churn, coverage reports and the file watcher; the history provider, config
 * loader and dismissals store arrive in M5. Side effects live here
 * (CLAUDE.md, "Repo layout").
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
export * from "./coverage.js";
export * from "./score.js";
export * from "./watch.js";
