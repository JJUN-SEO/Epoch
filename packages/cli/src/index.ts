/**
 * @epoch-dev/cli
 *
 * The headless `epoch` command (benchmarks, CI). It shares the engine
 * package with the app, so behavior is identical headless and in the UI
 * (CLAUDE.md, "Architecture"). The bin lives in bin.ts; this entry point
 * exports the testable pieces and has no side effects.
 */
export * from "./run.js";
export * from "./summary.js";
