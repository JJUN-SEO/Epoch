import { z } from "zod";
import { AnalysisMeta } from "@epoch-dev/core";

/*
 * Messages between main and the analysis host (a utilityProcess). Both sides
 * parse what they receive. A graph arrives already validated: the engine's
 * analyze() parses it with the Graph schema before returning it, so main does
 * not parse thousands of nodes a second time on its own thread. A delta is
 * the difference between two such graphs (core's diffGraphs), computed in
 * the host; main applies it with core's applyDelta.
 */

export const ProgressMessage = z.object({
  stage: z.enum(["discover", "parse", "resolve", "graph", "done"]),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/** What the analysis used: git history, coverage, config and findings checks (AnalysisInfo). */
export const AnalysisInfoMessage = z.strictObject({
  git: AnalysisMeta.shape.git,
  coverage: AnalysisMeta.shape.coverage,
  config: AnalysisMeta.shape.config,
  findings: AnalysisMeta.shape.findings,
});

/** Lines a code preview may return at most (CodePreview). */
export const MAX_PREVIEW_LINES = 200;
/** Characters kept per previewed line; longer lines (minified code) are cut. */
export const MAX_PREVIEW_LINE_CHARS = 1000;

/**
 * A repo-relative file path as the renderer may send it: forward slashes, no
 * empty, "." or ".." segment, nothing absolute, no drive letter or backslash.
 * The host still reads only through the root-confined reader.
 */
export const RepoRelativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes(":") &&
      !p.includes("\0") &&
      p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".."),
    "must be a repo-relative path",
  );

export const CodePreviewMessage = z.strictObject({
  file: z.string(),
  startLine: z.number().int().positive(),
  lines: z.array(z.string()).max(MAX_PREVIEW_LINES),
});

const StatusText = z.string().max(2000);

export const WatchStatusMessage = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("watching") }),
  z.strictObject({ state: z.literal("updating") }),
  z.strictObject({ state: z.literal("error"), message: StatusText }),
  z.strictObject({ state: z.literal("stopped"), message: StatusText }),
]);

export const HostRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("analyze"),
    id: z.number().int().nonnegative(),
    /** Absolute path of a folder main has checked against the granted roots. */
    root: z.string().min(1),
  }),
  /** Read-only lines of a file inside the open project, for the Details panel. */
  z.object({
    type: z.literal("preview"),
    id: z.number().int().nonnegative(),
    root: z.string().min(1),
    file: RepoRelativePath,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }),
]);
export type HostRequest = z.infer<typeof HostRequest>;

export const HostEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    id: z.number().int().nonnegative(),
    progress: ProgressMessage,
  }),
  z.object({
    type: z.literal("result"),
    id: z.number().int().nonnegative(),
    graph: z.unknown(),
    info: AnalysisInfoMessage,
  }),
  z.object({
    type: z.literal("error"),
    id: z.number().int().nonnegative(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("preview"),
    id: z.number().int().nonnegative(),
    preview: CodePreviewMessage,
  }),
  /** The watcher re-analyzed the open project and the graph changed. */
  z.object({
    type: z.literal("delta"),
    delta: z.unknown(),
    info: AnalysisInfoMessage,
  }),
  z.object({
    type: z.literal("watch-status"),
    status: WatchStatusMessage,
  }),
]);
export type HostEvent = z.infer<typeof HostEvent>;
