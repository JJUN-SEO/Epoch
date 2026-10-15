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

/** What the analysis used: git history and a coverage report (AnalysisInfo). */
export const AnalysisInfoMessage = z.strictObject({
  git: AnalysisMeta.shape.git,
  coverage: AnalysisMeta.shape.coverage,
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
