/**
 * @epoch-dev/findings
 *
 * Dead-feature detectors (dead-branch, stale-flag, unreachable-file), the
 * deterministic confidence rubric, flag pattern packs and the framework list
 * (data). Pure (CLAUDE.md, "Repo layout"): no I/O; git history comes in
 * through the GitHistoryProvider interface and hashing is injected.
 */
export * from "./packs.js";
export * from "./frameworks.js";
export * from "./input.js";
export { looksLikeDebugToggle } from "./dead-branch.js";
export { UNREACHABLE_CAVEAT } from "./unreachable.js";
export { runFindings } from "./run.js";
